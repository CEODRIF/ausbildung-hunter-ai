"use client";

import type {
  ButtonHTMLAttributes,
  InputHTMLAttributes,
  ReactNode,
} from "react";
import { useEffect } from "react";

const buttonStyles = {
  primary:
    "bg-[#2f6fed] text-white shadow-[0_8px_18px_rgba(47,111,237,0.22)] hover:bg-[#255dcc]",
  secondary:
    "border border-[#dbe3ef] bg-white text-[#1d3458] hover:border-[#b9c9e2] hover:bg-[#f8faff]",
  ghost: "text-[#6d7d96] hover:bg-[#f1f5fb] hover:text-[#1d3458]",
  dark: "bg-[#10203b] text-white shadow-[0_8px_18px_rgba(16,32,59,0.18)] hover:bg-[#1d3458]",
} as const;

type ButtonProps = ButtonHTMLAttributes<HTMLButtonElement> & {
  variant?: keyof typeof buttonStyles;
  size?: "sm" | "md" | "lg";
  children: ReactNode;
};

export function Button({
  className = "",
  variant = "primary",
  size = "md",
  children,
  ...props
}: ButtonProps) {
  const sizes = {
    sm: "h-9 px-3.5 text-xs",
    md: "h-11 px-4.5 text-sm",
    lg: "h-12 px-5 text-sm",
  };
  return (
    <button
      className={`inline-flex items-center justify-center gap-2 rounded-xl font-semibold transition-colors disabled:cursor-not-allowed disabled:opacity-50 ${sizes[size]} ${buttonStyles[variant]} ${className}`}
      {...props}
    >
      {children}
    </button>
  );
}

type InputProps = InputHTMLAttributes<HTMLInputElement> & {
  label?: string;
  hint?: string;
  error?: string;
  leading?: ReactNode;
};

export function Input({
  label,
  hint,
  error,
  leading,
  id,
  className = "",
  ...props
}: InputProps) {
  return (
    <label className="block" htmlFor={id}>
      {label && (
        <span className="mb-2 block text-sm font-semibold text-[#1d3458]">
          {label}
        </span>
      )}
      <span className="relative block">
        {leading && (
          <span className="pointer-events-none absolute left-3.5 top-1/2 -translate-y-1/2 text-[#8b9ab0]">
            {leading}
          </span>
        )}
        <input
          id={id}
          className={`h-12 w-full rounded-xl border bg-white px-3.5 text-sm text-[#10203b] outline-none transition placeholder:text-[#a0adbf] focus:border-[#2f6fed] focus:ring-4 focus:ring-[#2f6fed]/10 ${leading ? "pl-10" : ""} ${error ? "border-[#d9535d]" : "border-[#dfe6f0]"} ${className}`}
          {...props}
        />
      </span>
      {error ? (
        <span className="mt-1.5 block text-xs font-medium text-[#d9535d]">
          {error}
        </span>
      ) : hint ? (
        <span className="mt-1.5 block text-xs text-[#8492a7]">{hint}</span>
      ) : null}
    </label>
  );
}

type CardProps = {
  children: ReactNode;
  className?: string;
  as?: "div" | "section";
};

export function Card({ children, className = "", as = "div" }: CardProps) {
  const Component = as;
  return (
    <Component
      className={`rounded-2xl border border-[#e7ecf3] bg-white ${className}`}
    >
      {children}
    </Component>
  );
}

type ModalProps = {
  open: boolean;
  onClose: () => void;
  title: string;
  children: ReactNode;
};

export function Modal({ open, onClose, title, children }: ModalProps) {
  useEffect(() => {
    if (!open) return;
    const onKeyDown = (event: KeyboardEvent) =>
      event.key === "Escape" && onClose();
    document.addEventListener("keydown", onKeyDown);
    document.body.style.overflow = "hidden";
    return () => {
      document.removeEventListener("keydown", onKeyDown);
      document.body.style.overflow = "";
    };
  }, [open, onClose]);

  if (!open) return null;
  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center p-4"
      role="dialog"
      aria-modal="true"
      aria-label={title}
    >
      <button
        className="absolute inset-0 bg-[#10203b]/45 backdrop-blur-[2px]"
        aria-label="Close modal"
        onClick={onClose}
      />
      <div className="relative z-10 w-full max-w-md rounded-2xl border border-white/70 bg-white p-6 shadow-2xl">
        <div className="mb-5 flex items-start justify-between gap-4">
          <h2 className="text-lg font-bold text-[#10203b]">{title}</h2>
          <button
            className="rounded-lg p-1.5 text-[#8b9ab0] hover:bg-[#f2f5f9] hover:text-[#1d3458]"
            onClick={onClose}
            aria-label="Close modal"
          >
            <CloseIcon />
          </button>
        </div>
        {children}
      </div>
    </div>
  );
}

export function LoadingState({ label = "Loading" }: { label?: string }) {
  return (
    <div
      className="flex items-center gap-3 text-sm text-[#6d7d96]"
      role="status"
      aria-label={label}
    >
      <span className="h-4 w-4 animate-spin rounded-full border-2 border-[#dbe5f4] border-t-[#2f6fed]" />
      {label}
    </div>
  );
}

export function ErrorState({
  title = "Something went wrong",
  description = "Please try again.",
  onRetry,
}: {
  title?: string;
  description?: string;
  onRetry?: () => void;
}) {
  return (
    <div
      className="rounded-2xl border border-[#f5d7da] bg-[#fff8f8] p-5"
      role="alert"
    >
      <div className="flex gap-3">
        <span className="mt-0.5 flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-[#fde8e9] text-[#d9535d]">
          <AlertIcon />
        </span>
        <div>
          <h2 className="font-semibold text-[#6e2630]">{title}</h2>
          <p className="mt-1 text-sm leading-6 text-[#9a5e65]">{description}</p>
          {onRetry && (
            <Button
              className="mt-3"
              variant="secondary"
              size="sm"
              onClick={onRetry}
            >
              Try again
            </Button>
          )}
        </div>
      </div>
    </div>
  );
}

export function CloseIcon() {
  return (
    <svg
      aria-hidden="true"
      width="17"
      height="17"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
    >
      <path d="m6 6 12 12M18 6 6 18" />
    </svg>
  );
}

function AlertIcon() {
  return (
    <svg
      aria-hidden="true"
      width="16"
      height="16"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
    >
      <path d="M12 8v4M12 16h.01" />
      <circle cx="12" cy="12" r="9" />
    </svg>
  );
}
