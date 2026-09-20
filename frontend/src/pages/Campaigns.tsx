import { useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Copy, Plus } from 'lucide-react';
import { api, apiErrorMessage } from '../api/client';
import { PageHeader, Card, StatCard, StatusBadge, Spinner, Field, Modal } from '../components/ui';
import { DataTable, Column } from '../components/DataTable';
import { formatPaise } from '../lib/money';

const CAMPAIGN_TYPES = ['DIGITAL', 'PRINT', 'EVENTS', 'REFERRAL', 'CHANNEL_PARTNER'];
const SEGMENTS = ['RESIDENTIAL', 'COMMERCIAL', 'MIXED'];
const STATUSES = ['DRAFT', 'ACTIVE', 'PAUSED', 'COMPLETED', 'ARCHIVED'];

// Allowed next states from each status (drives the transition buttons in the drawer).
const NEXT_STATUS: Record<string, string[]> = {
  DRAFT: ['ACTIVE'],
  ACTIVE: ['PAUSED', 'COMPLETED'],
  PAUSED: ['ACTIVE', 'COMPLETED'],
  COMPLETED: ['ARCHIVED'],
  ARCHIVED: [],
};

interface NewCampaign {
  name: string;
  type: string;
  segment: string;
  startDate: string;
  endDate: string;
  budgetRupees: string;
}

const emptyForm: NewCampaign = {
  name: '',
  type: 'DIGITAL',
  segment: 'RESIDENTIAL',
  startDate: '',
  endDate: '',
  budgetRupees: '',
};

export default function Campaigns() {
  const navigate = useNavigate();
  const { id } = useParams();
  const queryClient = useQueryClient();

  const [statusFilter, setStatusFilter] = useState('');
  const [showCreate, setShowCreate] = useState(false);
  const [form, setForm] = useState<NewCampaign>(emptyForm);
  const [error, setError] = useState('');

  const list = useQuery({
    queryKey: ['campaigns', statusFilter],
    queryFn: async () => {
      const params = statusFilter ? { status: statusFilter } : {};
      return (await api.get('/campaigns', { params })).data as { data: any[]; meta: any };
    },
  });

  const createMut = useMutation({
    mutationFn: async (body: NewCampaign) =>
      (await api.post('/campaigns', {
        name: body.name,
        type: body.type,
        segment: body.segment,
        startDate: body.startDate || undefined,
        endDate: body.endDate || undefined,
        budgetRupees: body.budgetRupees ? Number(body.budgetRupees) : undefined,
      })).data,
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['campaigns'] });
      setShowCreate(false);
      setForm(emptyForm);
      setError('');
    },
    onError: (e) => setError(apiErrorMessage(e)),
  });

  const columns: Column<any>[] = [
    { key: 'name', header: 'Name', render: (r) => <span className="font-medium text-slate-900">{r.name}</span> },
    { key: 'type', header: 'Type', render: (r) => <span className="text-slate-600">{String(r.type).replace(/_/g, ' ')}</span> },
    { key: 'segment', header: 'Segment', render: (r) => <span className="text-slate-600">{r.segment}</span> },
    { key: 'status', header: 'Status', render: (r) => <StatusBadge status={r.status} /> },
    { key: 'budgetPaise', header: 'Budget', render: (r) => formatPaise(r.budgetPaise) },
    { key: 'leads', header: 'Leads', render: (r) => r._count?.leads ?? 0 },
  ];

  return (
    <div>
      <PageHeader
        title="Campaigns"
        subtitle="Plan, track and measure your marketing spend"
        actions={
          <>
            <select className="input w-44" value={statusFilter} onChange={(e) => setStatusFilter(e.target.value)}>
              <option value="">All statuses</option>
              {STATUSES.map((s) => (
                <option key={s} value={s}>{s.replace(/_/g, ' ')}</option>
              ))}
            </select>
            <button className="btn-primary" onClick={() => { setForm(emptyForm); setError(''); setShowCreate(true); }}>
              <Plus size={16} /> New Campaign
            </button>
          </>
        }
      />

      <DataTable
        columns={columns}
        rows={list.data?.data}
        loading={list.isLoading}
        onRowClick={(r) => navigate(`/campaigns/${r.id}`)}
        emptyTitle="No campaigns yet"
        emptyHint="Create your first campaign to start capturing leads."
      />

      {/* Create modal */}
      <Modal
        open={showCreate}
        onClose={() => setShowCreate(false)}
        title="New Campaign"
        footer={
          <>
            <button className="btn-ghost" onClick={() => setShowCreate(false)}>Cancel</button>
            <button className="btn-primary" disabled={!form.name || createMut.isPending} onClick={() => createMut.mutate(form)}>
              {createMut.isPending ? 'Saving…' : 'Create'}
            </button>
          </>
        }
      >
        <div className="space-y-3">
          {error && <div className="rounded-lg bg-rose-50 px-3 py-2 text-sm text-rose-600">{error}</div>}
          <Field label="Name">
            <input className="input" value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} />
          </Field>
          <div className="grid grid-cols-2 gap-3">
            <Field label="Type">
              <select className="input" value={form.type} onChange={(e) => setForm({ ...form, type: e.target.value })}>
                {CAMPAIGN_TYPES.map((t) => <option key={t} value={t}>{t.replace(/_/g, ' ')}</option>)}
              </select>
            </Field>
            <Field label="Segment">
              <select className="input" value={form.segment} onChange={(e) => setForm({ ...form, segment: e.target.value })}>
                {SEGMENTS.map((s) => <option key={s} value={s}>{s}</option>)}
              </select>
            </Field>
          </div>
          <div className="grid grid-cols-2 gap-3">
            <Field label="Start date">
              <input type="date" className="input" value={form.startDate} onChange={(e) => setForm({ ...form, startDate: e.target.value })} />
            </Field>
            <Field label="End date">
              <input type="date" className="input" value={form.endDate} onChange={(e) => setForm({ ...form, endDate: e.target.value })} />
            </Field>
          </div>
          <Field label="Budget (₹)">
            <input type="number" min="0" className="input" value={form.budgetRupees} onChange={(e) => setForm({ ...form, budgetRupees: e.target.value })} />
          </Field>
        </div>
      </Modal>

      {/* Detail drawer */}
      {id && <CampaignDrawer id={id} onClose={() => navigate('/campaigns')} />}
    </div>
  );
}

function CampaignDrawer({ id, onClose }: { id: string; onClose: () => void }) {
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  const [error, setError] = useState('');

  const detail = useQuery({
    queryKey: ['campaign', id],
    queryFn: async () => (await api.get(`/campaigns/${id}`)).data,
  });
  const analytics = useQuery({
    queryKey: ['campaign-analytics', id],
    queryFn: async () => (await api.get(`/campaigns/${id}/analytics`)).data,
  });

  const cloneMut = useMutation({
    mutationFn: async () => (await api.post(`/campaigns/${id}/clone`)).data,
    onSuccess: (c) => {
      queryClient.invalidateQueries({ queryKey: ['campaigns'] });
      if (c?.id) navigate(`/campaigns/${c.id}`);
    },
    onError: (e) => setError(apiErrorMessage(e)),
  });

  const statusMut = useMutation({
    mutationFn: async (status: string) => (await api.patch(`/campaigns/${id}/status`, { status })).data,
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['campaign', id] });
      queryClient.invalidateQueries({ queryKey: ['campaigns'] });
      setError('');
    },
    onError: (e) => setError(apiErrorMessage(e)),
  });

  const c = detail.data;
  const a = analytics.data ?? {};
  const transitions = c ? NEXT_STATUS[c.status] ?? [] : [];

  return (
    <div className="fixed inset-0 z-50 flex justify-end bg-slate-900/40" onClick={onClose}>
      <div className="h-full w-full max-w-md overflow-y-auto bg-surface shadow-xl" onClick={(e) => e.stopPropagation()}>
        <div className="flex items-center justify-between border-b px-5 py-3.5">
          <h3 className="font-semibold text-slate-800">Campaign details</h3>
          <button className="text-slate-400 hover:text-slate-600" onClick={onClose}>✕</button>
        </div>

        {detail.isLoading ? (
          <Spinner />
        ) : !c ? (
          <div className="p-5 text-sm text-slate-500">Not found.</div>
        ) : (
          <div className="space-y-5 p-5">
            {error && <div className="rounded-lg bg-rose-50 px-3 py-2 text-sm text-rose-600">{error}</div>}

            <div>
              <div className="flex items-center justify-between">
                <h2 className="text-lg font-semibold text-slate-900">{c.name}</h2>
                <StatusBadge status={c.status} />
              </div>
              <p className="mt-1 text-sm text-slate-500">
                {String(c.type).replace(/_/g, ' ')} · {c.segment}
              </p>
            </div>

            <div className="grid grid-cols-2 gap-3 text-sm">
              <div>
                <div className="label">Budget</div>
                <div className="font-medium text-slate-800">{formatPaise(c.budgetPaise)}</div>
              </div>
              <div>
                <div className="label">Leads</div>
                <div className="font-medium text-slate-800">{c._count?.leads ?? 0}</div>
              </div>
              <div>
                <div className="label">Start</div>
                <div className="text-slate-700">{c.startDate ? new Date(c.startDate).toLocaleDateString() : '—'}</div>
              </div>
              <div>
                <div className="label">End</div>
                <div className="text-slate-700">{c.endDate ? new Date(c.endDate).toLocaleDateString() : '—'}</div>
              </div>
            </div>

            {/* Analytics */}
            <div>
              <h4 className="mb-2 font-semibold text-slate-800">Analytics</h4>
              {analytics.isLoading ? (
                <Spinner />
              ) : (
                <div className="grid grid-cols-2 gap-3">
                  <StatCard label="Leads" value={a.leads ?? 0} />
                  <StatCard label="Cost / Lead" value={formatPaise(a.costPerLeadPaise)} />
                  <StatCard label="Conversion" value={`${a.conversionRate ?? a.conversionPercent ?? 0}%`} />
                  <StatCard label="ROI" value={`${a.roi ?? a.roiPercent ?? 0}%`} />
                </div>
              )}
            </div>

            {/* Actions */}
            <div className="space-y-2 border-t pt-4">
              <button className="btn-outline w-full justify-center" disabled={cloneMut.isPending} onClick={() => cloneMut.mutate()}>
                <Copy size={15} /> {cloneMut.isPending ? 'Cloning…' : 'Clone campaign'}
              </button>
              {transitions.length > 0 && (
                <div className="flex flex-wrap gap-2">
                  {transitions.map((s) => (
                    <button
                      key={s}
                      className="btn-primary flex-1 justify-center"
                      disabled={statusMut.isPending}
                      onClick={() => statusMut.mutate(s)}
                    >
                      Move to {s.replace(/_/g, ' ')}
                    </button>
                  ))}
                </div>
              )}
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
