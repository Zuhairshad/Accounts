import { randomUUID } from "node:crypto";
import { writeFile } from "node:fs/promises";
import { expect,test,type Page } from "@playwright/test";
import { drizzle } from "drizzle-orm/node-postgres";
import { Pool } from "pg";
import ExcelJS from "exceljs";
import * as schema from "../src/db/schema";
import { insertCompany } from "../src/db/seed";
import { hashPassword } from "../src/lib/password";

const url=process.env.AZAM_TEST_DATABASE_URL;
const password="Isolated reporting workflow password";
let companyId:string, otherId:string, username:string, viewer:string;
const root=()=>`/workspace/${companyId}/reports`;
const date="?day=2025-02-28";

test.beforeAll(async()=>{
  if (!url) return;
  if (!new URL(url).pathname.endsWith("_test")) throw new Error("Use a disposable _test database for browser fixtures.");
  const pool=new Pool({connectionString:url});
  try {
    const db=drizzle(pool,{schema});
    const suffix=randomUUID().slice(0,8);
    username=`reports-admin-${suffix}`;
    viewer=`reports-viewer-${suffix}`;
    const hash=await hashPassword(password);
    await db.transaction(async(tx)=>{
      companyId=(await insertCompany(tx,`Report browser ${suffix}`)).id;
      otherId=(await insertCompany(tx,`Report other ${suffix}`)).id;
      const [,limited]=await tx.insert(schema.users).values([
        {username,displayName:"Report admin",passwordHash:hash,mustChangePassword:false,superAdmin:true},
        {username:viewer,displayName:"Report viewer",passwordHash:hash,mustChangePassword:false},
      ]).returning();
      const [role]=await tx.insert(schema.companyRoles).values({companyId,name:"Limited report viewer",permissions:["view"]}).returning();
      await tx.insert(schema.companyMembers).values({companyId,roleId:role.id,userId:limited.id});
      const [year]=await tx.insert(schema.financialYears).values({companyId,name:"FY 2025",startsOn:"2025-01-01",endsOn:"2025-12-31"}).returning();
      await tx.insert(schema.periods).values({companyId,yearId:year.id,startsOn:year.startsOn,endsOn:year.endsOn});
    });
  }finally {await pool.end();}
});
async function login(page:Page,user=username) {
  await page.goto("/sign-in");
  await page.getByLabel("Username").fill(user);
  await page.getByLabel("Password").fill(password);
  await page.getByRole("button",{name:"Sign in"}).click();
  await expect(page).toHaveURL(/\/workspace\//);
}

test("recovers autosave after a lost reply, detects concurrent edits, posts once and downloads matching report files",async({page,browser},info)=>{
  test.skip(!url,"An isolated PostgreSQL database is required");
  test.setTimeout(90000);
  await login(page);
  await page.goto(`${root()}/day-book${date}&perspective=manual`);
  let dropped=0;
  let sendCount=0;
  const sentKeys:string[]=[];
  const registerRoute=`**/api/register/${companyId}/day-book`;
  await page.route(registerRoute,async(route)=>{
    if(route.request().method()==="POST"){
      sentKeys.push(route.request().postDataJSON().requestKey);
      sendCount++;
      if (!dropped) {const result=await route.fetch();expect(result.ok()).toBe(true);dropped++;await route.abort("failed");return;}
    }
    await route.continue();
  });
  await page.getByRole("button",{name:"Add row"}).click();
  await expect(page.getByText("Saved · Draft",{exact:true})).toBeVisible();
  expect(dropped).toBe(1);
  expect(sendCount).toBeGreaterThanOrEqual(2);
  expect(sentKeys[0]).toBe(sentKeys[1]);
  await page.unroute(registerRoute);
  await page.getByRole("textbox",{name:"description row 1"}).fill("Auto-saved receipt");
  await page.getByRole("textbox",{name:"first row 1"}).fill("125.75");
  await page.getByRole("textbox",{name:"ref row 1"}).fill("SOURCE-125");
  await expect(page.getByRole("button",{name:"Accounting entry"})).toBeVisible();
  await page.reload();
  await expect(page.getByRole("textbox",{name:"description row 1"})).toHaveValue("Auto-saved receipt");
  await expect(page.locator(".register-paper").getByText("125.75",{exact:true})).toHaveCount(2);

  const second=await browser.newPage();
  try {
    await login(second);
    await second.goto(`${root()}/day-book${date}`);
    await second.getByRole("textbox",{name:"description row 1"}).fill("Verified receipt");
    await expect(second.locator(".register-paper").getByText("Verified receipt",{exact:true})).toBeVisible();
    await page.getByRole("textbox",{name:"description row 1"}).fill("Stale edit");
    await expect(page.getByRole("alert").filter({hasText:"Conflict detected"}).first()).toBeVisible();
  } finally {await second.close();}
  await page.reload();
  await page.getByRole("button",{name:"Accounting entry"}).click();
  await page.getByRole("combobox",{name:"Workflow"}).selectOption("create");
  await page.getByRole("combobox",{name:"Cash or bank account"}).selectOption({label:"Cash"});
  await page.getByRole("combobox",{name:"Offset account"}).selectOption({label:"Other Income"});
  await page.getByRole("textbox",{name:"Reason"}).fill("Reviewed source receipt");
  await page.getByRole("checkbox",{name:"The entered Dr or Cr applies to the selected cash or bank account."}).check();
  await page.getByRole("button",{name:"Confirm accounting link"}).click();
  await expect(page.getByRole("dialog")).toBeHidden();
  await page.getByRole("button",{name:"Add row"}).click();
  await page.getByRole("textbox",{name:"description row 1"}).fill("Repeated reference");
  await page.getByRole("textbox",{name:"first row 1"}).fill("125.75");
  await page.getByRole("textbox",{name:"ref row 1"}).fill("source-125");
  await page.getByRole("button",{name:"Accounting entry"}).click();
  await page.getByRole("combobox",{name:"Workflow"}).selectOption("create");
  await page.getByRole("combobox",{name:"Cash or bank account"}).selectOption({label:"Cash"});
  await page.getByRole("combobox",{name:"Offset account"}).selectOption({label:"Other Income"});
  await page.getByRole("textbox",{name:"Reason"}).fill("Check duplicate source");
  await page.getByRole("checkbox",{name:"The entered Dr or Cr applies to the selected cash or bank account."}).check();
  await page.getByRole("button",{name:"Confirm accounting link"}).click();
  await expect(page.getByText("A posted voucher uses this reference.")).toBeVisible();
  await page.getByRole("button",{name:"Close",exact:true}).click();
  await page.goto(`${root()}/day-book${date}&perspective=cash`);
  const credited=page.locator(".register-paper tbody tr").filter({hasText:"Verified receipt"});
  await expect(credited).toHaveCount(1);
  await expect(credited.locator("td").nth(6)).toHaveText("125.75");
  await page.goto(`${root()}/voucher-register${date}`);
  await expect(page.getByRole("row").filter({hasText:"Verified receipt"})).toHaveCount(1);

  await page.goto(`${root()}/profit-loss${date}`);
  const net=page.getByRole("row").filter({hasText:"Net Profit / Loss"});
  await expect(net).toContainText("125.75");
  const xlsx=await page.request.get((await page.getByRole("link",{name:"Download Excel"}).getAttribute("href"))!);
  expect(xlsx.status()).toBe(200);
  const book=new ExcelJS.Workbook();
  const data=await xlsx.body();
  await book.xlsx.load(data.buffer.slice(data.byteOffset,data.byteOffset+data.byteLength) as ExcelJS.Buffer);
  const excelNet=book.worksheets[0].getRows(1,book.worksheets[0].rowCount)?.find((row)=>row.getCell(1).text==="Net Profit / Loss");
  expect(excelNet?.getCell(3).value).toBe(125.75);
  const pdf=await page.request.get((await page.getByRole("link",{name:"Download PDF"}).getAttribute("href"))!);
  expect(pdf.status()).toBe(200);
  const standardPdf=await pdf.body();
  expect(standardPdf.subarray(0,4).toString()).toBe("%PDF");
  expect(standardPdf.toString("latin1")).toContain("/MediaBox [0 0 595.28 841.89]");
  await writeFile(info.outputPath("profit-loss.pdf"),standardPdf);
  await info.attach("profit-loss-pdf",{body:standardPdf,contentType:"application/pdf"});
  const csv=await page.request.get((await page.getByRole("link",{name:"Download CSV"}).getAttribute("href"))!);
  expect(await csv.text()).toContain('"Net Profit / Loss","","125.75"');

  for(const [id,title,head] of [["day-book","Day Book","Bal"],["sale-purchase","Sale / Purchase","Sale Amount"]]){
    await page.goto(`${root()}/${id}${date}&preview=1&blank=1`);
    await expect(page.getByRole("heading",{name:title,exact:true})).toBeVisible();
    await expect(page.getByRole("columnheader")).toHaveCount(7);
    await expect(page.getByRole("columnheader").last()).toHaveText(head);
    await expect(page.getByRole("button",{name:"Print",exact:true})).toBeVisible();
    await page.locator(".report-preview-page").screenshot({path:info.outputPath(`${id}-preview.png`)});
    const artifact=await page.request.get(`/api/reports/${companyId}/${id}${date}&format=pdf&blank=1`);
    const body=await artifact.body();
    expect(body.subarray(0,4).toString()).toBe("%PDF");
    expect(body.toString("latin1")).toContain("/MediaBox [0 0 595.28 841.89]");
    await writeFile(info.outputPath(`${id}-blank.pdf`),body);
    await info.attach(`${id}-blank`,{body,contentType:"application/pdf"});
  }
});

test("limits combined reporting, audit and downloads to authorized company permissions",async({page})=>{
  test.skip(!url,"An isolated PostgreSQL database is required");
  await login(page,viewer);
  await page.goto(`${root()}/mis${date}`);
  await expect(page.getByRole("heading",{name:"Daily MIS",exact:true})).toBeVisible();
  await expect(page.getByRole("link",{name:"Download PDF"})).toHaveCount(0);
  expect((await page.request.get(`/api/reports/${companyId}/mis${date}&format=xlsx`)).status()).toBe(404);
  await page.goto(`${root()}/mis${date}&company=${otherId}`);
  await expect(page.getByRole("heading",{name:"Page unavailable"})).toBeVisible();
  await page.goto(`${root()}/mis${date}&status=void`);
  await expect(page.getByRole("heading",{name:"Page unavailable"})).toBeVisible();
});
