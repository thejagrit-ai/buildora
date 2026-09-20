import { useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Plus } from 'lucide-react';
import { api, apiErrorMessage } from '../api/client';
import { PageHeader, Card, StatusBadge, Spinner, Field, Modal, EmptyState } from '../components/ui';
import { DataTable, Column } from '../components/DataTable';
import { formatPaise } from '../lib/money';
import { CustomFieldInputs, CustomFieldsPanel, saveCustomFieldValues } from '../components/customFields';

const ACCOUNT_TYPES = ['INDIVIDUAL', 'CORPORATE', 'CHANNEL_PARTNER', 'INVESTOR'];

// KYC transition map (drives the action buttons in the 360 view).
const KYC_NEXT: Record<string, string[]> = {
  PENDING: ['SUBMITTED'],
  SUBMITTED: ['VERIFIED', 'REJECTED'],
  VERIFIED: [],
  REJECTED: ['SUBMITTED'],
};

const TYPE_BADGE: Record<string, string> = {
  INDIVIDUAL: 'bg-slate-100 text-slate-600',
  CORPORATE: 'bg-blue-100 text-blue-700',
  CHANNEL_PARTNER: 'bg-violet-100 text-violet-700',
  INVESTOR: 'bg-amber-100 text-amber-700',
};

function TypeBadge({ type }: { type?: string | null }) {
  if (!type) return <span className="text-slate-400">—</span>;
  return (
    <span className={`inline-flex rounded-full px-2.5 py-0.5 text-xs font-medium ${TYPE_BADGE[type] ?? 'bg-slate-100 text-slate-600'}`}>
      {type.replace(/_/g, ' ')}
    </span>
  );
}

interface NewAccount {
  name: string;
  type: string;
  pan: string;
  gstin: string;
  city: string;
  state: string;
  contactName: string;
  contactMobile: string;
  contactEmail: string;
}

const emptyAccount: NewAccount = {
  name: '', type: 'INDIVIDUAL', pan: '', gstin: '', city: '', state: '',
  contactName: '', contactMobile: '', contactEmail: '',
};

export default function Accounts() {
  const navigate = useNavigate();
  const { id } = useParams();
  const queryClient = useQueryClient();

  const [typeFilter, setTypeFilter] = useState('');
  const [showCreate, setShowCreate] = useState(false);
  const [form, setForm] = useState<NewAccount>(emptyAccount);
  const [customValues, setCustomValues] = useState<Record<string, any>>({});
  const [error, setError] = useState('');

  const list = useQuery({
    queryKey: ['accounts', typeFilter],
    queryFn: async () => {
      const params = typeFilter ? { type: typeFilter } : {};
      return (await api.get('/accounts', { params })).data as { data: any[]; meta: any };
    },
  });

  const createMut = useMutation({
    mutationFn: async (body: NewAccount) => {
      const created = (await api.post('/accounts', {
        name: body.name,
        type: body.type,
        pan: body.pan || undefined,
        gstin: body.gstin || undefined,
        city: body.city || undefined,
        state: body.state || undefined,
        contacts: [
          {
            name: body.contactName,
            mobile: body.contactMobile,
            email: body.contactEmail || undefined,
            isPrimary: true,
          },
        ],
      })).data;
      await saveCustomFieldValues('ACCOUNT', created.id, customValues);
      return created;
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['accounts'] });
      setShowCreate(false);
      setForm(emptyAccount);
      setCustomValues({});
      setError('');
    },
    onError: (e) => setError(apiErrorMessage(e)),
  });

  const columns: Column<any>[] = [
    { key: 'name', header: 'Name', render: (r) => <span className="font-medium text-slate-900">{r.name}</span> },
    { key: 'type', header: 'Type', render: (r) => <TypeBadge type={r.type} /> },
    { key: 'kycStatus', header: 'KYC', render: (r) => <StatusBadge status={r.kycStatus} /> },
    { key: 'city', header: 'City', render: (r) => r.city ?? '—' },
    { key: 'contacts', header: 'Contacts', render: (r) => r._count?.contacts ?? r.contacts?.length ?? 0 },
  ];

  return (
    <div>
      <PageHeader
        title="Accounts"
        subtitle="Companies, individuals, partners and investors"
        actions={
          <>
            <select className="input w-48" value={typeFilter} onChange={(e) => setTypeFilter(e.target.value)}>
              <option value="">All types</option>
              {ACCOUNT_TYPES.map((t) => <option key={t} value={t}>{t.replace(/_/g, ' ')}</option>)}
            </select>
            <button className="btn-primary" onClick={() => { setForm(emptyAccount); setError(''); setShowCreate(true); }}>
              <Plus size={16} /> New Account
            </button>
          </>
        }
      />

      <DataTable
        columns={columns}
        rows={list.data?.data}
        loading={list.isLoading}
        onRowClick={(r) => navigate(`/accounts/${r.id}`)}
        emptyTitle="No accounts yet"
        emptyHint="Create your first account to start tracking relationships."
      />

      {/* Create modal */}
      <Modal
        open={showCreate}
        onClose={() => setShowCreate(false)}
        title="New Account"
        footer={
          <>
            <button className="btn-ghost" onClick={() => setShowCreate(false)}>Cancel</button>
            <button
              className="btn-primary"
              disabled={!form.name || !form.contactName || !form.contactMobile || createMut.isPending}
              onClick={() => createMut.mutate(form)}
            >
              {createMut.isPending ? 'Saving…' : 'Create'}
            </button>
          </>
        }
      >
        <div className="space-y-3">
          {error && <div className="rounded-lg bg-rose-50 px-3 py-2 text-sm text-rose-600">{error}</div>}
          <div className="grid grid-cols-2 gap-3">
            <Field label="Name">
              <input className="input" value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} />
            </Field>
            <Field label="Type">
              <select className="input" value={form.type} onChange={(e) => setForm({ ...form, type: e.target.value })}>
                {ACCOUNT_TYPES.map((t) => <option key={t} value={t}>{t.replace(/_/g, ' ')}</option>)}
              </select>
            </Field>
          </div>
          <div className="grid grid-cols-2 gap-3">
            <Field label="PAN">
              <input className="input" value={form.pan} onChange={(e) => setForm({ ...form, pan: e.target.value })} />
            </Field>
            <Field label="GSTIN">
              <input className="input" value={form.gstin} onChange={(e) => setForm({ ...form, gstin: e.target.value })} />
            </Field>
          </div>
          <div className="grid grid-cols-2 gap-3">
            <Field label="City">
              <input className="input" value={form.city} onChange={(e) => setForm({ ...form, city: e.target.value })} />
            </Field>
            <Field label="State">
              <input className="input" value={form.state} onChange={(e) => setForm({ ...form, state: e.target.value })} />
            </Field>
          </div>

          <div className="border-t pt-3">
            <p className="mb-2 text-xs font-semibold uppercase tracking-wide text-slate-500">Primary contact</p>
            <div className="space-y-3">
              <div className="grid grid-cols-2 gap-3">
                <Field label="Contact name">
                  <input className="input" value={form.contactName} onChange={(e) => setForm({ ...form, contactName: e.target.value })} />
                </Field>
                <Field label="Contact mobile">
                  <input className="input" value={form.contactMobile} onChange={(e) => setForm({ ...form, contactMobile: e.target.value })} />
                </Field>
              </div>
              <Field label="Contact email">
                <input className="input" type="email" value={form.contactEmail} onChange={(e) => setForm({ ...form, contactEmail: e.target.value })} />
              </Field>
            </div>
          </div>

          <CustomFieldInputs objectType="ACCOUNT" values={customValues} onChange={setCustomValues} />
        </div>
      </Modal>

      {id && <AccountDrawer id={id} onClose={() => navigate('/accounts')} />}
    </div>
  );
}

const TABS = ['Contacts', 'Leads', 'Opportunities', 'Bookings', 'Documents'] as const;
type Tab = (typeof TABS)[number];

function AccountDrawer({ id, onClose }: { id: string; onClose: () => void }) {
  const queryClient = useQueryClient();
  const [tab, setTab] = useState<Tab>('Contacts');
  const [error, setError] = useState('');

  const detail = useQuery({
    queryKey: ['account', id],
    queryFn: async () => (await api.get(`/accounts/${id}`)).data,
  });

  const kycMut = useMutation({
    mutationFn: async (kycStatus: string) => (await api.patch(`/accounts/${id}/kyc`, { kycStatus })).data,
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['account', id] });
      queryClient.invalidateQueries({ queryKey: ['accounts'] });
      setError('');
    },
    onError: (e) => setError(apiErrorMessage(e)),
  });

  const a = detail.data;
  const kycTransitions = a ? KYC_NEXT[a.kycStatus] ?? [] : [];

  return (
    <div className="fixed inset-0 z-50 flex justify-end bg-slate-900/40" onClick={onClose}>
      <div className="h-full w-full max-w-xl overflow-y-auto bg-surface shadow-xl" onClick={(e) => e.stopPropagation()}>
        <div className="flex items-center justify-between border-b px-5 py-3.5">
          <h3 className="font-semibold text-slate-800">Account 360</h3>
          <button className="text-slate-400 hover:text-slate-600" onClick={onClose}>✕</button>
        </div>

        {detail.isLoading ? (
          <Spinner />
        ) : !a ? (
          <div className="p-5 text-sm text-slate-500">Not found.</div>
        ) : (
          <div className="space-y-5 p-5">
            {error && <div className="rounded-lg bg-rose-50 px-3 py-2 text-sm text-rose-600">{error}</div>}

            <div>
              <div className="flex items-center justify-between gap-3">
                <h2 className="text-lg font-semibold text-slate-900">{a.name}</h2>
                <div className="flex items-center gap-2">
                  <TypeBadge type={a.type} />
                  <StatusBadge status={a.kycStatus} />
                </div>
              </div>
              <p className="mt-1 text-sm text-slate-500">
                {[a.city, a.state].filter(Boolean).join(', ') || '—'}
                {a.pan ? ` · PAN ${a.pan}` : ''}
                {a.gstin ? ` · GSTIN ${a.gstin}` : ''}
              </p>
            </div>

            <CustomFieldsPanel objectType="ACCOUNT" recordId={id} />

            {/* KYC actions */}
            {kycTransitions.length > 0 && (
              <div className="flex flex-wrap gap-2 rounded-lg bg-slate-50 p-3">
                <span className="self-center text-xs font-medium text-slate-500">KYC actions:</span>
                {kycTransitions.map((s) => (
                  <button
                    key={s}
                    className={s === 'REJECTED' ? 'btn-outline' : 'btn-primary'}
                    disabled={kycMut.isPending}
                    onClick={() => kycMut.mutate(s)}
                  >
                    {s === 'SUBMITTED' ? 'Submit' : s === 'VERIFIED' ? 'Verify' : s === 'REJECTED' ? 'Reject' : s}
                  </button>
                ))}
              </div>
            )}

            {/* Channel partner extras */}
            {a.type === 'CHANNEL_PARTNER' && (
              <Card className="!p-4">
                <h4 className="mb-2 font-semibold text-slate-800">Channel Partner</h4>
                <div className="grid grid-cols-2 gap-3 text-sm">
                  <div>
                    <div className="label">Empanelment</div>
                    <StatusBadge status={a.empanelmentStatus ?? a.partner?.empanelmentStatus} />
                  </div>
                  <div>
                    <div className="label">Commission</div>
                    <div className="font-medium text-slate-800">
                      {a.commissionRate != null || a.partner?.commissionRate != null
                        ? `${a.commissionRate ?? a.partner?.commissionRate}%`
                        : a.commissionPaise != null
                          ? formatPaise(a.commissionPaise)
                          : '—'}
                    </div>
                  </div>
                </div>
              </Card>
            )}

            {/* Tabs */}
            <div>
              <div className="flex gap-1 border-b">
                {TABS.map((t) => (
                  <button
                    key={t}
                    className={`px-3 py-2 text-sm font-medium ${tab === t ? 'border-b-2 border-brand-600 text-brand-700' : 'text-slate-500 hover:text-slate-700'}`}
                    onClick={() => setTab(t)}
                  >
                    {t}
                  </button>
                ))}
              </div>
              <div className="pt-4">
                <TabContent tab={tab} account={a} />
              </div>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

function TabContent({ tab, account }: { tab: Tab; account: any }) {
  if (tab === 'Contacts') {
    const contacts: any[] = account.contacts ?? [];
    if (contacts.length === 0) return <EmptyState title="No contacts" />;
    return (
      <div className="space-y-2">
        {contacts.map((c, i) => (
          <div key={c.id ?? i} className="flex items-center justify-between rounded-lg border border-slate-200 px-3 py-2.5">
            <div>
              <div className="flex items-center gap-2">
                <span className="font-medium text-slate-800">{c.name}</span>
                {c.isPrimary && <span className="rounded-full bg-brand-50 px-2 py-0.5 text-xs font-medium text-brand-700">Primary</span>}
              </div>
              <div className="text-xs text-slate-500">{[c.mobile, c.email].filter(Boolean).join(' · ') || '—'}</div>
            </div>
          </div>
        ))}
      </div>
    );
  }

  if (tab === 'Leads') {
    const rows: any[] = account.leads ?? [];
    if (rows.length === 0) return <EmptyState title="No leads" />;
    return (
      <div className="space-y-2">
        {rows.map((l, i) => (
          <div key={l.id ?? i} className="flex items-center justify-between rounded-lg border border-slate-200 px-3 py-2.5">
            <span className="font-medium text-slate-800">{l.name}</span>
            <StatusBadge status={l.stage} />
          </div>
        ))}
      </div>
    );
  }

  if (tab === 'Opportunities') {
    const rows: any[] = account.opportunities ?? [];
    if (rows.length === 0) return <EmptyState title="No opportunities" />;
    return (
      <div className="space-y-2">
        {rows.map((o, i) => (
          <div key={o.id ?? i} className="flex items-center justify-between rounded-lg border border-slate-200 px-3 py-2.5">
            <div>
              <div className="font-medium text-slate-800">{o.name ?? o.title ?? 'Opportunity'}</div>
              <div className="text-xs text-slate-500">{formatPaise(o.dealValuePaise ?? o.valuePaise)}</div>
            </div>
            <StatusBadge status={o.stage ?? o.status} />
          </div>
        ))}
      </div>
    );
  }

  if (tab === 'Bookings') {
    const rows: any[] = account.bookings ?? [];
    if (rows.length === 0) return <EmptyState title="No bookings" />;
    return (
      <div className="space-y-2">
        {rows.map((b, i) => (
          <div key={b.id ?? i} className="flex items-center justify-between rounded-lg border border-slate-200 px-3 py-2.5">
            <div>
              <div className="font-medium text-slate-800">{b.unitName ?? b.code ?? b.unit?.name ?? 'Booking'}</div>
              <div className="text-xs text-slate-500">{formatPaise(b.dealValuePaise ?? b.valuePaise)}</div>
            </div>
            <StatusBadge status={b.status} />
          </div>
        ))}
      </div>
    );
  }

  // Documents
  const rows: any[] = account.documents ?? [];
  if (rows.length === 0) return <EmptyState title="No documents" />;
  return (
    <div className="space-y-2">
      {rows.map((d, i) => (
        <div key={d.id ?? i} className="flex items-center justify-between rounded-lg border border-slate-200 px-3 py-2.5">
          <div>
            <div className="font-medium text-slate-800">{d.name ?? d.fileName ?? 'Document'}</div>
            <div className="text-xs text-slate-500">{String(d.type ?? d.category ?? '').replace(/_/g, ' ')}</div>
          </div>
          {d.url && (
            <a className="text-sm font-medium text-brand-700 hover:underline" href={d.url} target="_blank" rel="noreferrer">
              View
            </a>
          )}
        </div>
      ))}
    </div>
  );
}
