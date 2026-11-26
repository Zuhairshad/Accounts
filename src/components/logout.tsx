"use client";

import { signOut } from "next-auth/react";
import { LogOut } from "lucide-react";
import { Button } from "./ui/button";

export function Logout() {
  return <Button type="button" variant="ghost" onClick={() => signOut({ callbackUrl: "/sign-in" })}><LogOut size={16} /> Sign out</Button>;
}
