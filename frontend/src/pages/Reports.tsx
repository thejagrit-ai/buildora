import { useMemo, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  BarChart3, Clock, MapPin, GitBranch, Boxes, FileSignature, Wallet,
  AlertTriangle, UserCheck, Handshake, Megaphone, XCircle, Download,
  Plus, Trash2, Hammer,
} from 'lucide-react';
import { api, apiErrorMessage } from '../api/client';
import { PageHeader, Card, Spinner, EmptyState, Field } from '../components/ui';
import { DataTable, Column } from '../components/DataTable';
import { formatPaise } from '../lib/money';
import { useAuth } from '../store/auth';

// ── Standard reports ──────────────────────────────────────────────────────────

interface ReportDef {
  key: string;
  label: string;
  endpoint: string;
  icon: typeof BarChart3;
}

const REPORTS: ReportDef[] = [
  { key: 'leads', label: 'Leads', endpoint: '/reports/leads', icon: BarChart3 },
  { key: 'lead-aging', label: 'Lead Aging', endpoint: '/reports/lead-aging', icon: Clock },
  { key: 'site-visits', label: 'Site Visits', endpoint: '/reports/site-visits', icon: MapPin },
  { key: 'pipeline', label: 'Pipeline', endpoint: '/reports/pipeline', icon: GitBranch },
  { key: 'inventory', label: 'Inventory', endpoint: '/reports/inventory', icon: Boxes },
  { key: 'bookings', label: 'Bookings', endpoint: '/reports/bookings', icon: FileSignature },
  { key: 'collections', label: 'Collections', endpoint: '/reports/collections', icon: Wallet },
  { key: 'outstanding', label: 'Outstanding', endpoint: '/reports/outstanding', icon: AlertTriangle },
  { key: 'agent-performance', label: 'Agent Performance', endpoint: '/reports/agent-performance', icon: UserCheck },
  { key: 'cp-performance', label: 'CP Performance', endpoint: '/reports/cp-performance', icon: Handshake },
  { key: 'campaign-roi', label: 'Campaign ROI', endpoint: '/reports/campaign-roi', icon: Megaphone },
  { key: 'cancellations', label: 'Cancellations', endpoint: '/reports/cancellations', icon: XCircle },
];

interface ReportResult {
  columns: { key: string; header?: string; label?: string }[] | string[];
  rows: any[];
  generatedAt?: string;
  summary?: Record<string, any>;
}

function normalizeColumns(cols: ReportResult['columns']): { key: string; header: string }[] {
  return (cols ?? []).map((c) =>
    typeof c === 'string'
      ? { key: c, header: c }
      : { key: c.key, header: c.header ?? c.label ?? c.key },
  );
}

const isPaiseKey = (key: string) => /paise$/i.test(key);

function renderCell(key: string, value: any): string {
  if (value == null || value === '') return '—';
  if (isPaiseKey(key)) return formatPaise(value);
  if (typeof value === 'object') return JSON.stringify(value);
  return String(value);
}

function csvEscape(value: string): string {
  if (/[",\n]/.test(value)) return `"${value.replace(/"/g, '""')}"`;
  return value;
}

function exportCsv(name: string, cols: { key: string; header: string }[], rows: any[]) {
  const header = cols.map((c) => csvEscape(c.header)).join(',');
  const body = rows
    .map((row) => cols.map((c) => csvEscape(renderCell(c.key, row[c.key]))).join(','))
    .join('\n');
  const blob = new Blob([`${header}\n${body}`], { type: 'text/csv;charset=utf-8;' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `${name}-${new Date().toISOString().slice(0, 10)}.csv`;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
}

function GenericReportTable({ result, loading }: { result?: ReportResult; loading?: boolean }) {
  const cols = useMemo(() => normalizeColumns(result?.columns ?? []), [result]);
  const columns: Column<any>[] = cols.map((c) => ({
    key: c.key,
    header: c.header,
    render: (row) => renderCell(c.key, row[c.key]),
  }));
  return (
    <DataTable
      columns={columns}
      rows={result?.rows}
      loading={loading}
      emptyTitle="No data"
      emptyHint="Adjust the date range and run the report again."
    />
  );
}

// ── Page ──────────────────────────────────────────────────────────────────────

export default function Reports() {
  const { can } = useAuth();
  const [active, setActive] = useState<ReportDef>(REPORTS[0]);
  const [from, setFrom] = useState('');
  const [to, setTo] = useState('');

  const report = useQuery({
    queryKey: ['report', active.key, from, to],
    queryFn: async () =>
      (await api.get(active.endpoint, {
        params: { ...(from ? { from } : {}), ...(to ? { to } : {}) },
      })).data as ReportResult,
  });

  const cols = useMemo(() => normalizeColumns(report.data?.columns ?? []), [report.data]);
  const rows = report.data?.rows ?? [];
  const summary = report.data?.summary;

  return (
    <div>
      <PageHeader
        title="Reports"
        subtitle="Standard analytics and a custom report builder"
        actions={
          <button
            className="btn-outline"
            disabled={!report.data || rows.length === 0}
            onClick={() => exportCsv(active.key, cols, rows)}
          >
            <Download size={16} /> Export Excel/CSV
          </button>
        }
      />

      <div className="grid grid-cols-1 gap-6 lg:grid-cols-[220px_1fr]">
        {/* Sidebar */}
        <nav className="card h-fit p-2">
          {REPORTS.map((r) => {
            const Icon = r.icon;
            const isActive = r.key === active.key;
            return (
              <button
                key={r.key}
                onClick={() => setActive(r)}
                className={`flex w-full items-center gap-2.5 rounded-lg px-3 py-2 text-left text-sm font-medium transition ${
                  isActive ? 'bg-brand-600 text-white' : 'text-slate-600 hover:bg-slate-100'
                }`}
              >
                <Icon size={16} /> {r.label}
              </button>
            );
          })}
        </nav>

        {/* Report panel */}
        <div className="space-y-4">
          <Card>
            <div className="flex flex-wrap items-end justify-between gap-3">
              <div>
                <h3 className="font-semibold text-slate-800">{active.label} report</h3>
                {report.data?.generatedAt && (
                  <p className="mt-0.5 text-xs text-slate-400">
                    Generated {new Date(report.data.generatedAt).toLocaleString()}
                  </p>
                )}
              </div>
              <div className="flex items-end gap-3">
                <Field label="From">
                  <input type="date" className="input" value={from} onChange={(e) => setFrom(e.target.value)} />
                </Field>
                <Field label="To">
                  <input type="date" className="input" value={to} onChange={(e) => setTo(e.target.value)} />
                </Field>
                <button className="btn-primary" onClick={() => report.refetch()}>Run</button>
              </div>
            </div>

            {summary && Object.keys(summary).length > 0 && (
              <div className="mt-4 grid grid-cols-2 gap-3 sm:grid-cols-4">
                {Object.entries(summary).map(([key, value]) => (
                  <div key={key} className="rounded-lg bg-slate-50 px-3 py-2">
                    <div className="text-xs font-medium uppercase tracking-wide text-slate-500">
                      {key.replace(/([A-Z])/g, ' $1').replace(/_/g, ' ').trim()}
                    </div>
                    <div className="mt-0.5 max-w-full break-words whitespace-pre-wrap text-sm font-semibold text-slate-800">
                      {renderCell(key, value)}
                    </div>
                  </div>
                ))}
              </div>
            )}
          </Card>

          <GenericReportTable result={report.data} loading={report.isLoading} />
        </div>
      </div>

      {can('reports.build') && <CustomReportBuilder />}
    </div>
  );
}

// ── Custom report builder ───────────────────────────────────────────────────────

const MODULES = ['lead', 'opportunity', 'booking', 'account', 'siteVisit'] as const;
type ModuleKey = (typeof MODULES)[number];

const MODULE_FIELDS: Record<ModuleKey, string[]> = {
  lead: ['name', 'mobile', 'email', 'stage', 'sourceChannel', 'score', 'budgetMaxPaise', 'createdAt'],
  opportunity: ['name', 'stage', 'valuePaise', 'probability', 'ownerName', 'expectedCloseDate', 'createdAt'],
  booking: ['bookingNo', 'status', 'unitName', 'accountName', 'agreementValuePaise', 'bookingDate'],
  account: ['name', 'type', 'primaryContact', 'phone', 'email', 'outstandingPaise', 'createdAt'],
  siteVisit: ['leadName', 'projectName', 'status', 'scheduledAt', 'agentName', 'feedback'],
};

const OPS = ['eq', 'contains', 'gt', 'lt', 'gte', 'lte'] as const;
const AGG_FNS = ['SUM', 'COUNT', 'AVG'] as const;

interface Condition {
  field: string;
  op: (typeof OPS)[number];
  value: string;
}

function CustomReportBuilder() {
  const queryClient = useQueryClient();
  const [module, setModule] = useState<ModuleKey>('lead');
  const [fields, setFields] = useState<string[]>([]);
  const [conditions, setConditions] = useState<Condition[]>([]);
  const [groupBy, setGroupBy] = useState('');
  const [aggFn, setAggFn] = useState<(typeof AGG_FNS)[number] | ''>('');
  const [aggField, setAggField] = useState('');
  const [result, setResult] = useState<ReportResult | null>(null);
  const [error, setError] = useState('');
  const [saveName, setSaveName] = useState('');

  const moduleFields = MODULE_FIELDS[module];

  function setModuleReset(m: ModuleKey) {
    setModule(m);
    setFields([]);
    setConditions([]);
    setGroupBy('');
    setAggField('');
    setResult(null);
  }

  function toggleField(f: string) {
    setFields((prev) => (prev.includes(f) ? prev.filter((x) => x !== f) : [...prev, f]));
  }

  function buildDefinition() {
    return {
      module,
      fields,
      filters: conditions.filter((c) => c.field),
      ...(groupBy ? { groupBy } : {}),
      ...(aggFn && aggField ? { aggregate: { fn: aggFn, field: aggField } } : {}),
    };
  }

  const runMut = useMutation({
    mutationFn: async () => (await api.post('/reports/custom', buildDefinition())).data as ReportResult,
    onSuccess: (data) => { setResult(data); setError(''); },
    onError: (e) => setError(apiErrorMessage(e)),
  });

  const saved = useQuery({
    queryKey: ['saved-reports'],
    queryFn: async () => {
      const res = (await api.get('/reports/saved')).data;
      return (Array.isArray(res) ? res : res?.data ?? []) as any[];
    },
  });

  const saveMut = useMutation({
    mutationFn: async () =>
      (await api.post('/reports/saved', { name: saveName, module, definition: buildDefinition() })).data,
    onSuccess: () => {
      setSaveName('');
      queryClient.invalidateQueries({ queryKey: ['saved-reports'] });
    },
    onError: (e) => setError(apiErrorMessage(e)),
  });

  const deleteMut = useMutation({
    mutationFn: async (id: string) => (await api.delete(`/reports/saved/${id}`)).data,
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['saved-reports'] }),
  });

  function loadSaved(s: any) {
    const d = s.definition ?? {};
    setModule(s.module ?? d.module ?? 'lead');
    setFields(d.fields ?? []);
    setConditions(d.filters ?? []);
    setGroupBy(d.groupBy ?? '');
    setAggFn(d.aggregate?.fn ?? '');
    setAggField(d.aggregate?.field ?? '');
    setResult(null);
  }

  return (
    <div className="mt-10">
      <div className="mb-4 flex items-center gap-2">
        <Hammer size={18} className="text-brand-600" />
        <h2 className="text-lg font-semibold text-slate-900">Custom Report Builder</h2>
      </div>

      <div className="grid grid-cols-1 gap-6 lg:grid-cols-[1fr_280px]">
        <Card className="space-y-5">
          {error && <div className="rounded-lg bg-rose-50 px-3 py-2 text-sm text-rose-600">{error}</div>}

          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
            <Field label="Module">
              <select className="input" value={module} onChange={(e) => setModuleReset(e.target.value as ModuleKey)}>
                {MODULES.map((m) => <option key={m} value={m}>{m}</option>)}
              </select>
            </Field>
          </div>

          {/* Fields */}
          <div>
            <span className="label">Fields</span>
            <div className="flex flex-wrap gap-2">
              {moduleFields.map((f) => {
                const checked = fields.includes(f);
                return (
                  <label
                    key={f}
                    className={`flex cursor-pointer items-center gap-1.5 rounded-lg border px-2.5 py-1 text-sm ${
                      checked ? 'border-brand-500 bg-brand-50 text-brand-700' : 'border-slate-300 text-slate-600'
                    }`}
                  >
                    <input type="checkbox" checked={checked} onChange={() => toggleField(f)} className="accent-brand-600" />
                    {f}
                  </label>
                );
              })}
            </div>
          </div>

          {/* Conditions */}
          <div>
            <div className="mb-2 flex items-center justify-between">
              <span className="label !mb-0">Filter conditions</span>
              <button
                className="btn-ghost !py-1 text-xs"
                onClick={() => setConditions([...conditions, { field: moduleFields[0], op: 'eq', value: '' }])}
              >
                <Plus size={14} /> Add condition
              </button>
            </div>
            <div className="space-y-2">
              {conditions.length === 0 && <p className="text-xs text-slate-400">No filters. The report returns all rows.</p>}
              {conditions.map((c, i) => (
                <div key={i} className="flex items-center gap-2">
                  <select
                    className="input"
                    value={c.field}
                    onChange={(e) => setConditions(conditions.map((x, j) => (j === i ? { ...x, field: e.target.value } : x)))}
                  >
                    {moduleFields.map((f) => <option key={f} value={f}>{f}</option>)}
                  </select>
                  <select
                    className="input !w-28"
                    value={c.op}
                    onChange={(e) => setConditions(conditions.map((x, j) => (j === i ? { ...x, op: e.target.value as Condition['op'] } : x)))}
                  >
                    {OPS.map((o) => <option key={o} value={o}>{o}</option>)}
                  </select>
                  <input
                    className="input"
                    placeholder="value"
                    value={c.value}
                    onChange={(e) => setConditions(conditions.map((x, j) => (j === i ? { ...x, value: e.target.value } : x)))}
                  />
                  <button className="btn-ghost !px-2" onClick={() => setConditions(conditions.filter((_, j) => j !== i))}>
                    <Trash2 size={15} />
                  </button>
                </div>
              ))}
            </div>
          </div>

          {/* Group + aggregate */}
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-3">
            <Field label="Group by">
              <select className="input" value={groupBy} onChange={(e) => setGroupBy(e.target.value)}>
                <option value="">None</option>
                {moduleFields.map((f) => <option key={f} value={f}>{f}</option>)}
              </select>
            </Field>
            <Field label="Aggregate fn">
              <select className="input" value={aggFn} onChange={(e) => setAggFn(e.target.value as any)}>
                <option value="">None</option>
                {AGG_FNS.map((f) => <option key={f} value={f}>{f}</option>)}
              </select>
            </Field>
            <Field label="Aggregate field">
              <select className="input" value={aggField} onChange={(e) => setAggField(e.target.value)} disabled={!aggFn}>
                <option value="">Select…</option>
                {moduleFields.map((f) => <option key={f} value={f}>{f}</option>)}
              </select>
            </Field>
          </div>

          <div className="flex flex-wrap items-end gap-3 border-t border-slate-100 pt-4">
            <button className="btn-primary" disabled={fields.length === 0 || runMut.isPending} onClick={() => runMut.mutate()}>
              {runMut.isPending ? 'Running…' : 'Run report'}
            </button>
            <button className="btn-outline" disabled={!result || result.rows.length === 0} onClick={() => result && exportCsv(`custom-${module}`, normalizeColumns(result.columns), result.rows)}>
              <Download size={16} /> Export Excel/CSV
            </button>
            <div className="flex items-end gap-2">
              <Field label="Save as">
                <input className="input" placeholder="Report name" value={saveName} onChange={(e) => setSaveName(e.target.value)} />
              </Field>
              <button className="btn-outline" disabled={!saveName.trim() || fields.length === 0 || saveMut.isPending} onClick={() => saveMut.mutate()}>
                {saveMut.isPending ? 'Saving…' : 'Save'}
              </button>
            </div>
          </div>

          {result && (
            <div>
              <h4 className="mb-2 font-semibold text-slate-800">Result</h4>
              <GenericReportTable result={result} />
            </div>
          )}
        </Card>

        {/* Saved reports */}
        <Card className="h-fit">
          <h4 className="mb-3 font-semibold text-slate-800">Saved reports</h4>
          {saved.isLoading ? (
            <Spinner />
          ) : (saved.data ?? []).length === 0 ? (
            <EmptyState title="No saved reports" hint="Build and save a report to reuse it." />
          ) : (
            <div className="space-y-2">
              {(saved.data ?? []).map((s: any) => (
                <div key={s.id} className="flex items-center justify-between rounded-lg border border-slate-200 px-3 py-2">
                  <button className="text-left" onClick={() => loadSaved(s)}>
                    <div className="text-sm font-medium text-slate-800">{s.name}</div>
                    <div className="text-xs text-slate-400">{s.module ?? s.definition?.module}</div>
                  </button>
                  <button className="text-slate-400 hover:text-rose-600" onClick={() => deleteMut.mutate(s.id)}>
                    <Trash2 size={15} />
                  </button>
                </div>
              ))}
            </div>
          )}
        </Card>
      </div>
    </div>
  );
}
