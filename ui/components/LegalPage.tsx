import type { ReactNode } from 'react';

/** Shared layout for the standalone Terms and Privacy pages. */
export default function LegalPage({ title, updated, children }: { title: string; updated: string; children: ReactNode }) {
  return (
    <main className="mx-auto max-w-2xl px-6 py-12 text-sm leading-relaxed text-safe-text [&_h2]:mt-8 [&_h2]:mb-2 [&_h2]:text-base [&_h2]:font-semibold [&_h2]:text-white [&_p]:mb-3 [&_ul]:mb-3 [&_ul]:list-disc [&_ul]:pl-5 [&_a]:underline">
      <h1 className="mb-1 text-2xl font-semibold text-white">{title}</h1>
      <p className="text-xs">Last updated: {updated}</p>
      {children}
    </main>
  );
}
