import { ReactNode } from 'react';

// ── Status badge vocabulary (consistent colors across all modules) ──
const STATUS_COLORS: Record<string, string> = {
  // generic
  ACTIVE: 'bg-emerald-100 text-emerald-700',
  DRAFT: 'bg-slate-100 text-slate-600',
  PAUSED: 'bg-amber-100 text-amber-700',
  COMPLETED: 'bg-blue-100 text-blue-700',
  ARCHIVED: 'bg-slate-100 text-slate-500',
  // leads / opps
  NEW: 'bg-sky-100 text-sky-700',
  CONTACTED: 'bg-indigo-100 text-indigo-700',
  QUALIFIED: 'bg-violet-100 text-violet-700',
  SITE_VISIT_SCHEDULED: 'bg-cyan-100 text-cyan-700',
  SITE_VISIT_DONE: 'bg-cyan-100 text-cyan-700',
  NEGOTIATION: 'bg-amber-100 text-amber-700',
  VERBAL_COMMIT: 'bg-orange-100 text-orange-700',
  PROSPECT: 'bg-sky-100 text-sky-700',
  CONVERTED: 'bg-emerald-100 text-emerald-700',
  WON: 'bg-emerald-100 text-emerald-700',
  LOST: 'bg-rose-100 text-rose-700',
  // inventory
  AVAILABLE: 'bg-emerald-100 text-emerald-700',
  BLOCKED: 'bg-amber-100 text-amber-700',
  BOOKED: 'bg-orange-100 text-orange-700',
  REGISTERED: 'bg-blue-100 text-blue-700',
  CANCELLED: 'bg-rose-100 text-rose-700',
  // kyc / status
  PENDING: 'bg-slate-100 text-slate-600',
  SUBMITTED: 'bg-amber-100 text-amber-700',
  VERIFIED: 'bg-emerald-100 text-emerald-700',
  REJECTED: 'bg-rose-100 text-rose-700',
  // finance
  PAID: 'bg-emerald-100 text-emerald-700',
  PARTIALLY_PAID: 'bg-amber-100 text-amber-700',
  OVERDUE: 'bg-rose-100 text-rose-700',
  SENT: 'bg-blue-100 text-blue-700',
  CONFIRMED: 'bg-emerald-100 text-emerald-700',
};

export function StatusBadge({ status }: { status?: string | null }) {
  if (!status) return <span className="text-slate-400">—</span>;
  const cls = STATUS_COLORS[status] ?? 'bg-slate-100 text-slate-600';
  return (
    <span className={`inline-flex rounded-full px-2.5 py-0.5 text-xs font-medium ${cls}`}>
      {status.replace(/_/g, ' ')}
    </span>
  );
}

export function PageHeader({
  title,
  subtitle,
  actions,
}: {
  title: string;
  subtitle?: string;
  actions?: ReactNode;
}) {
  return (
    <div className="mb-6 flex items-end justify-between gap-4">
      <div>
        <h1 className="text-xl font-semibold text-slate-900">{title}</h1>
        {subtitle && <p className="mt-0.5 text-sm text-slate-500">{subtitle}</p>}
      </div>
      {actions && <div className="flex items-center gap-2">{actions}</div>}
    </div>
  );
}

export function Card({ children, className = '' }: { children: ReactNode; className?: string }) {
  return <div className={`card p-5 ${className}`}>{children}</div>;
}

export function StatCard({ label, value, hint }: { label: string; value: ReactNode; hint?: string }) {
  return (
    <div className="card p-5">
      <div className="text-xs font-medium uppercase tracking-wide text-slate-500">{label}</div>
      <div className="mt-2 text-2xl font-semibold text-slate-900">{value}</div>
      {hint && <div className="mt-1 text-xs text-slate-400">{hint}</div>}
    </div>
  );
}

export function EmptyState({
  title,
  hint,
  action,
}: {
  title: string;
  hint?: string;
  action?: ReactNode;
}) {
  return (
    <div className="flex flex-col items-center justify-center rounded-xl border border-dashed border-slate-300 bg-surface py-16 text-center">
      <p className="font-medium text-slate-700">{title}</p>
      {hint && <p className="mt-1 text-sm text-slate-400">{hint}</p>}
      {action && <div className="mt-4">{action}</div>}
    </div>
  );
}

export function Spinner() {
  return (
    <div className="flex items-center justify-center py-16 text-slate-400">
      <div className="h-6 w-6 animate-spin rounded-full border-2 border-slate-300 border-t-brand-600" />
    </div>
  );
}

export function Field({ label, children }: { label: string; children: ReactNode }) {
  return (
    <label className="block">
      <span className="label">{label}</span>
      {children}
    </label>
  );
}

export function Modal({
  open,
  onClose,
  title,
  children,
  footer,
}: {
  open: boolean;
  onClose: () => void;
  title: string;
  children: ReactNode;
  footer?: ReactNode;
}) {
  if (!open) return null;
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-slate-900/40 p-4" onClick={onClose}>
      <div className="w-full max-w-lg rounded-xl bg-surface shadow-xl" onClick={(e) => e.stopPropagation()}>
        <div className="flex items-center justify-between border-b px-5 py-3.5">
          <h3 className="font-semibold text-slate-800">{title}</h3>
          <button className="text-slate-400 hover:text-slate-600" onClick={onClose}>✕</button>
        </div>
        <div className="max-h-[70vh] overflow-y-auto px-5 py-4">{children}</div>
        {footer && <div className="flex justify-end gap-2 border-t px-5 py-3">{footer}</div>}
      </div>
    </div>
  );
}
