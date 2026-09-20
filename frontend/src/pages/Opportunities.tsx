import { useMemo, useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import {
  ResponsiveContainer, BarChart, Bar, XAxis, YAxis, Tooltip, CartesianGrid,
} from 'recharts';
import dayjs from 'dayjs';
import { Plus, LayoutGrid, List as ListIcon } from 'lucide-react';
import { api, apiErrorMessage } from '../api/client';
import { PageHeader, Card, StatusBadge, EmptyState, Spinner, Field, Modal } from '../components/ui';
import { DataTable, Column } from '../components/DataTable';
import { formatPaise } from '../lib/money';
import { useAuth } from '../store/auth';
import { CustomFieldInputs, saveCustomFieldValues } from '../components/customFields';

const STAGES = [
  'PROSPECT', 'QUALIFIED', 'SITE_VISIT_DONE', 'NEGOTIATION', 'VERBAL_COMMIT', 'WON', 'LOST',
] as const;
type Stage = (typeof STAGES)[number];

function accountName(o: any): string {
  return o.account?.name ?? o.accountName ?? '—';
}

export default function Opportunities() {
  const qc = useQueryClient();
  const can = useAuth((s) => s.can);
  const [view, setView] = useState<'pipeline' | 'list'>('pipeline');
  const [alert, setAlert] = useState<string | null>(null);
  const [showNew, setShowNew] = useState(false);
  const [dragId, setDragId] = useState<string | null>(null);

  const oppsQ = useQuery({
    queryKey: ['opportunities'],
    queryFn: async () => (await api.get('/opportunities', { params: { limit: 200 } })).data,
  });
  const pipelineQ = useQuery({
    queryKey: ['opportunities', 'pipeline'],
    queryFn: async () => (await api.get('/opportunities/pipeline')).data,
  });
  const forecastQ = useQuery({
    queryKey: ['opportunities', 'forecast'],
    queryFn: async () => (await api.get('/opportunities/forecast')).data,
  });

  const opps: any[] = oppsQ.data?.data ?? [];
  const pipelineTotals: any[] = Array.isArray(pipelineQ.data) ? pipelineQ.data : [];
  const forecast: any[] = Array.isArray(forecastQ.data) ? forecastQ.data : [];

  const byStage = useMemo(() => {
    const m: Record<string, any[]> = {};
    STAGES.forEach((s) => (m[s] = []));
    opps.forEach((o) => {
      const s = o.stage as string;
      (m[s] ??= []).push(o);
    });
    return m;
  }, [opps]);

  const totalsByStage = useMemo(() => {
    const m: Record<string, { count: number; valuePaise: string }> = {};
    pipelineTotals.forEach((p) => {
      m[p.stage] = { count: p.count, valuePaise: String(p.valuePaise ?? '0') };
    });
    return m;
  }, [pipelineTotals]);

  const forecastData = useMemo(
    () => forecast.map((f) => ({
      month: f.month,
      weighted: Number(f.weightedPaise ?? 0) / 100,
      raw: Number(f.rawPaise ?? 0) / 100,
      count: f.count,
    })),
    [forecast],
  );

  const stageMut = useMutation({
    mutationFn: async (vars: { id: string; stage: Stage; lostReason?: string; override?: boolean }) => {
      const { id, ...body } = vars;
      return (await api.patch(`/opportunities/${id}/stage`, body)).data;
    },
    onSuccess: () => {
      setAlert(null);
      qc.invalidateQueries({ queryKey: ['opportunities'] });
    },
    onError: (err) => setAlert(apiErrorMessage(err)),
  });

  function handleDrop(stage: Stage) {
    if (!dragId) return;
    const id = dragId;
    setDragId(null);
    const opp = opps.find((o) => o.id === id);
    if (!opp || opp.stage === stage) return;
    if (stage === 'LOST') {
      const lostReason = window.prompt('Reason for marking LOST (required):')?.trim();
      if (!lostReason) return;
      stageMut.mutate({ id, stage, lostReason });
      return;
    }
    stageMut.mutate({ id, stage });
  }

  const columns: Column<any>[] = [
    { key: 'name', header: 'Opportunity', render: (o) => <span className="font-medium text-slate-800">{o.name}</span> },
    { key: 'account', header: 'Account', render: (o) => accountName(o) },
    { key: 'stage', header: 'Stage', render: (o) => <StatusBadge status={o.stage} /> },
    { key: 'dealValuePaise', header: 'Deal Value', render: (o) => formatPaise(o.dealValuePaise) },
    { key: 'probability', header: 'Prob.', render: (o) => `${o.probability ?? 0}%` },
    {
      key: 'expectedCloseAt',
      header: 'Expected Close',
      render: (o) => (o.expectedCloseAt ? dayjs(o.expectedCloseAt).format('DD MMM YYYY') : '—'),
    },
  ];

  return (
    <div>
      <PageHeader
        title="Opportunities"
        subtitle="Deal pipeline and revenue forecast"
        actions={
          <div className="flex items-center gap-2">
            <div className="flex overflow-hidden rounded-lg border border-slate-200">
              <button
                className={`flex items-center gap-1.5 px-3 py-1.5 text-sm font-medium ${view === 'pipeline' ? 'bg-brand-50 text-brand-700' : 'bg-surface text-slate-600 hover:bg-slate-50'}`}
                onClick={() => setView('pipeline')}
              >
                <LayoutGrid className="h-4 w-4" /> Pipeline
              </button>
              <button
                className={`flex items-center gap-1.5 px-3 py-1.5 text-sm font-medium ${view === 'list' ? 'bg-brand-50 text-brand-700' : 'bg-surface text-slate-600 hover:bg-slate-50'}`}
                onClick={() => setView('list')}
              >
                <ListIcon className="h-4 w-4" /> List
              </button>
            </div>
            {can('opportunities.create') && (
              <button className="btn-primary flex items-center gap-1.5" onClick={() => setShowNew(true)}>
                <Plus className="h-4 w-4" /> New Opportunity
              </button>
            )}
          </div>
        }
      />

      {alert && (
        <div className="mb-4 flex items-start justify-between gap-3 rounded-lg border border-rose-200 bg-rose-50 px-4 py-3 text-sm text-rose-700">
          <span>{alert}</span>
          <button className="text-rose-400 hover:text-rose-600" onClick={() => setAlert(null)}>✕</button>
        </div>
      )}

      <Card className="mb-6">
        <h3 className="mb-4 font-semibold text-slate-800">Weighted forecast by month</h3>
        {forecastQ.isLoading ? (
          <Spinner />
        ) : forecastData.length === 0 ? (
          <p className="text-sm text-slate-400">No forecast data.</p>
        ) : (
          <div className="h-56">
            <ResponsiveContainer width="100%" height="100%">
              <BarChart data={forecastData}>
                <CartesianGrid strokeDasharray="3 3" vertical={false} stroke="#f1f5f9" />
                <XAxis dataKey="month" tick={{ fontSize: 11 }} />
                <YAxis tick={{ fontSize: 11 }} />
                <Tooltip formatter={(v: number) => `₹${v.toLocaleString('en-IN')}`} />
                <Bar dataKey="weighted" name="Weighted value" fill="#4f46e5" radius={[4, 4, 0, 0]} />
              </BarChart>
            </ResponsiveContainer>
          </div>
        )}
      </Card>

      {view === 'pipeline' ? (
        oppsQ.isLoading ? (
          <Spinner />
        ) : (
          <div className="grid grid-flow-col auto-cols-[minmax(240px,1fr)] gap-4 overflow-x-auto pb-2">
            {STAGES.map((stage) => {
              const cards = byStage[stage] ?? [];
              const totals = totalsByStage[stage];
              const colValue = totals
                ? formatPaise(totals.valuePaise)
                : formatPaise(cards.reduce((s, c) => s + BigInt(c.dealValuePaise ?? '0'), 0n).toString());
              const colCount = totals?.count ?? cards.length;
              return (
                <div
                  key={stage}
                  className="flex min-h-[200px] flex-col rounded-xl bg-slate-100/70 p-2"
                  onDragOver={(e) => e.preventDefault()}
                  onDrop={() => handleDrop(stage)}
                >
                  <div className="mb-2 px-1">
                    <div className="flex items-center justify-between">
                      <StatusBadge status={stage} />
                      <span className="text-xs font-semibold text-slate-500">{colCount}</span>
                    </div>
                    <div className="mt-1 text-xs font-medium text-slate-500">{colValue}</div>
                  </div>
                  <div className="flex flex-1 flex-col gap-2">
                    {cards.map((o) => (
                      <div
                        key={o.id}
                        draggable
                        onDragStart={() => setDragId(o.id)}
                        onDragEnd={() => setDragId(null)}
                        className="cursor-grab rounded-lg border border-slate-200 bg-surface p-3 shadow-sm transition hover:shadow active:cursor-grabbing"
                      >
                        <div className="text-sm font-medium text-slate-800">{o.name}</div>
                        <div className="mt-0.5 text-xs text-slate-500">{accountName(o)}</div>
                        <div className="mt-2 flex items-center justify-between">
                          <span className="text-sm font-semibold text-slate-700">{formatPaise(o.dealValuePaise)}</span>
                          <span className="text-xs text-slate-400">{o.probability ?? 0}%</span>
                        </div>
                      </div>
                    ))}
                    {cards.length === 0 && (
                      <div className="rounded-lg border border-dashed border-slate-300 py-6 text-center text-xs text-slate-400">
                        Drop here
                      </div>
                    )}
                  </div>
                </div>
              );
            })}
          </div>
        )
      ) : (
        <DataTable
          columns={columns}
          rows={opps}
          loading={oppsQ.isLoading}
          emptyTitle="No opportunities"
          emptyHint="Create your first opportunity to start tracking deals."
        />
      )}

      {showNew && <NewOpportunityModal onClose={() => setShowNew(false)} onError={setAlert} />}
    </div>
  );
}

function NewOpportunityModal({ onClose, onError }: { onClose: () => void; onError: (m: string) => void }) {
  const qc = useQueryClient();
  const [form, setForm] = useState({
    name: '',
    accountId: '',
    projectId: '',
    dealValueRupees: '',
    expectedCloseAt: '',
    stage: 'PROSPECT' as Stage,
  });
  const [customValues, setCustomValues] = useState<Record<string, any>>({});

  const accountsQ = useQuery({
    queryKey: ['accounts', 'select'],
    queryFn: async () => (await api.get('/accounts', { params: { limit: 200 } })).data,
  });
  const projectsQ = useQuery({
    queryKey: ['inventory', 'projects'],
    queryFn: async () => (await api.get('/inventory/projects')).data,
  });

  const accounts: any[] = accountsQ.data?.data ?? accountsQ.data ?? [];
  const projects: any[] = projectsQ.data?.data ?? projectsQ.data ?? [];

  const createMut = useMutation({
    mutationFn: async () => {
      const body: any = {
        name: form.name,
        accountId: form.accountId,
        stage: form.stage,
      };
      if (form.projectId) body.projectId = form.projectId;
      if (form.dealValueRupees) body.dealValueRupees = Number(form.dealValueRupees);
      if (form.expectedCloseAt) body.expectedCloseAt = form.expectedCloseAt;
      const created = (await api.post('/opportunities', body)).data;
      await saveCustomFieldValues('OPPORTUNITY', created.id, customValues);
      return created;
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['opportunities'] });
      onClose();
    },
    onError: (err) => onError(apiErrorMessage(err)),
  });

  const set = (k: keyof typeof form) => (e: React.ChangeEvent<any>) =>
    setForm((f) => ({ ...f, [k]: e.target.value }));

  const valid = form.name.trim() && form.accountId;

  return (
    <Modal
      open
      onClose={onClose}
      title="New Opportunity"
      footer={
        <>
          <button className="btn-ghost" onClick={onClose}>Cancel</button>
          <button
            className="btn-primary"
            disabled={!valid || createMut.isPending}
            onClick={() => createMut.mutate()}
          >
            {createMut.isPending ? 'Creating…' : 'Create'}
          </button>
        </>
      }
    >
      <div className="space-y-4">
        <Field label="Name">
          <input className="input" value={form.name} onChange={set('name')} placeholder="e.g. Sharma – 3BHK Tower A" />
        </Field>
        <Field label="Account">
          <select className="input" value={form.accountId} onChange={set('accountId')}>
            <option value="">Select account…</option>
            {accounts.map((a) => (
              <option key={a.id} value={a.id}>{a.name}</option>
            ))}
          </select>
        </Field>
        <Field label="Project (optional)">
          <select className="input" value={form.projectId} onChange={set('projectId')}>
            <option value="">Select project…</option>
            {projects.map((p) => (
              <option key={p.id} value={p.id}>{p.name}</option>
            ))}
          </select>
        </Field>
        <div className="grid grid-cols-2 gap-4">
          <Field label="Deal value (₹)">
            <input className="input" type="number" min="0" value={form.dealValueRupees} onChange={set('dealValueRupees')} placeholder="0" />
          </Field>
          <Field label="Expected close">
            <input className="input" type="date" value={form.expectedCloseAt} onChange={set('expectedCloseAt')} />
          </Field>
        </div>
        <Field label="Stage">
          <select className="input" value={form.stage} onChange={set('stage')}>
            {STAGES.map((s) => (
              <option key={s} value={s}>{s.replace(/_/g, ' ')}</option>
            ))}
          </select>
        </Field>
        <CustomFieldInputs objectType="OPPORTUNITY" values={customValues} onChange={setCustomValues} />
      </div>
    </Modal>
  );
}
