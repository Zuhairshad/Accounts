import { Slot } from "@radix-ui/react-slot";
import { cva, type VariantProps } from "class-variance-authority";
import { clsx } from "clsx";
import { twMerge } from "tailwind-merge";

const styles = cva("button", { variants: { variant: { primary: "button-primary", outline: "button-outline", danger: "button-danger", ghost: "button-ghost" } }, defaultVariants: { variant: "primary" } });

export function Button({ asChild, variant, className, ...props }: React.ComponentProps<"button"> & VariantProps<typeof styles> & { asChild?: boolean }) {
  const Component = asChild ? Slot : "button";
  return <Component className={twMerge(clsx(styles({ variant }), className))} {...props} />;
}
