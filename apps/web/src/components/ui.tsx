import Link from 'next/link';
import type { ButtonHTMLAttributes, InputHTMLAttributes, ReactNode } from 'react';

type ButtonProps = ButtonHTMLAttributes<HTMLButtonElement> & {
  tone?: 'primary' | 'quiet' | 'danger';
};

/** 44 px minimum height on every button: the iPad is the first target. */
export function Button({ tone = 'primary', className = '', ...props }: ButtonProps) {
  const tones = {
    primary: 'bg-navy text-board hover:bg-slate',
    quiet: 'border-2 border-slate text-slate hover:bg-board',
    danger: 'bg-polish text-board',
  };
  return (
    <button
      {...props}
      className={`min-h-11 rounded-control px-5 font-semibold disabled:opacity-50 ${tones[tone]} ${className}`}
    />
  );
}

export function LinkButton({
  href,
  tone = 'primary',
  children,
}: {
  href: string;
  tone?: 'primary' | 'quiet';
  children: ReactNode;
}) {
  const tones = {
    primary: 'bg-navy text-board hover:bg-slate',
    quiet: 'border-2 border-slate text-slate hover:bg-board',
  };
  return (
    <Link
      href={href}
      className={`inline-flex min-h-11 items-center rounded-control px-5 font-semibold ${tones[tone]}`}
    >
      {children}
    </Link>
  );
}

type FieldProps = InputHTMLAttributes<HTMLInputElement> & {
  label: string;
  error?: string;
};

/** One field per row, label above, error below in plain words. */
export function Field({ label, error, id, className = '', ...props }: FieldProps) {
  const errorId = error ? `${id}-error` : undefined;
  return (
    <div className="flex flex-col gap-2">
      <label htmlFor={id} className="font-medium">
        {label}
      </label>
      <input
        id={id}
        aria-invalid={error ? true : undefined}
        aria-describedby={errorId}
        {...props}
        className={`min-h-12 rounded-control border-2 bg-board px-4 text-lead ${error ? 'border-polish' : 'border-slate/30'} ${className}`}
      />
      {error ? (
        <p id={errorId} className="text-polish">
          {error}
        </p>
      ) : null}
    </div>
  );
}
