import { Suspense } from 'react';
import { FreeScan } from '@/components/FreeScan';

export const metadata = { title: 'Free product scan | AdtoCart', robots: { index: false } };
export default function StartPage() {
  return <Suspense fallback={<main className="p-10">Loading your free scan…</main>}><FreeScan /></Suspense>;
}
