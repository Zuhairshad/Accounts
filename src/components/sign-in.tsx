"use client";

import { signIn } from "next-auth/react";
import { useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { z } from "zod";
import { LoaderCircle, LockKeyhole } from "lucide-react";
import { usernameSchema } from "@/lib/validation";
import { Button } from "./ui/button";

const schema = z.object({ username: usernameSchema, password: z.string().min(1, "Enter your password.").max(128) });
type Credentials = z.infer<typeof schema>;

export function SignInForm() {
  const { register, handleSubmit, setError, formState: { errors, isSubmitting } } = useForm<Credentials>({ resolver: zodResolver(schema) });

  const submit = handleSubmit(async (values) => {
    try {
      const result = await signIn("credentials", { ...values, redirect: false, callbackUrl: "/workspace" });
      if (!result?.ok) {
        setError("root", { message: "Sign-in failed. Check your details or try again later." });
        return;
      }
      window.location.assign("/workspace");
    } catch {
      setError("root", { message: "Sign-in is temporarily unavailable." });
    }
  });

  return <form onSubmit={submit} className="mt-7 space-y-5" noValidate>
    <label className="field">Username<input autoComplete="username" autoFocus aria-invalid={!!errors.username} {...register("username")} />
      {errors.username && <span className="form-error">{errors.username.message}</span>}</label>
    <label className="field">Password<input type="password" autoComplete="current-password" aria-invalid={!!errors.password} {...register("password")} />
      {errors.password && <span className="form-error">{errors.password.message}</span>}</label>
    {errors.root && <p className="form-error" role="alert">{errors.root.message}</p>}
    <Button type="submit" disabled={isSubmitting} className="w-full">{isSubmitting ? <LoaderCircle size={17} className="animate-spin" /> : <LockKeyhole size={17} />}{isSubmitting ? "Signing in…" : "Sign in"}</Button>
  </form>;
}
