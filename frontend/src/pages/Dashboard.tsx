import { useMemo, useState } from 'react';
import { useMutation, useQuery } from '@tanstack/react-query';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { ArrowUpRight, BarChart3, Bot, CalendarClock, ChevronRight, CircleDollarSign, ClipboardCheck, Home, Plus, Send, Target, TrendingUp, UsersRound, X } from 'lucide-react';
import { BarChart, Bar, Cell, Legend, Pie, PieChart, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts';
import { api } from '../api/client';
import { Card, Spinner } from '../components/ui';
import { formatPaise } from '../lib/money';
import { useAuth } from '../store/auth';

const DONUT_COLORS = ['#b55b2f', '#d89a5b', '#4f7f72', '#6688a8', '#ba6c72'];
const money = (value: unknown) => formatPaise(String(value ?? '0'));

type Metric = { label: string; value: string | number; detail: string; icon: typeof Target; tone: string };

function MetricCard({ metric }: { metric: Metric }) {
  const Icon = metric.icon;
  return <div className="group relative overflow-hidden rounded-2xl border border-slate-200 bg-surface p-5 shadow-sm transition duration-200 hover:-translate-y-0.5 hover:shadow-lg hover:shadow-slate-900/5"><div className={`mb-5 flex h-10 w-10 items-center justify-center rounded-xl ${metric.tone}`}><Icon className="h-[19px] w-[19px]" /></div><div className="text-[11px] font-bold uppercase tracking-[0.13em] text-slate-400">{metric.label}</div><div className="mt-1.5 text-[25px] font-semibold tracking-tight text-slate-900">{metric.value}</div><div className="mt-1 text-xs text-slate-500">{metric.detail}</div><ArrowUpRight className="absolute right-4 top-4 h-4 w-4 text-slate-200 transition group-hover:text-brand-500" /></div>;
}

function QuickAction({ label, to, icon: Icon }: { label: string; to: string; icon: typeof Plus }) { const navigate = useNavigate(); return <button onClick={() => navigate(to)} className="flex items-center gap-2 rounded-xl border border-slate-200 bg-surface px-3 py-2 text-xs font-semibold text-slate-600 transition hover:border-brand-200 hover:bg-brand-50 hover:text-brand-700"><Icon className="h-4 w-4" />{label}</button>; }

function Assistant() {
  const [open, setOpen] = useState(false); const [input, setInput] = useState(''); const [messages, setMessages] = useState<{ role: 'user' | 'assistant'; content: string }[]>([]);
  const chat = useMutation({ mutationFn: async (content: string) => (await api.post('/ai/chat', { messages: [...messages, { role: 'user', content }] })).data.message, onSuccess: (content, sent) => setMessages((prev) => [...prev, { role: 'user', content: sent }, { role: 'assistant', content }]) });
  const send = () => { const value = input.trim(); if (!value || chat.isPending) return; setInput(''); chat.mutate(value); };
  return <><button onClick={() => setOpen(true)} className="fixed bottom-6 right-6 z-30 flex items-center gap-2 rounded-full bg-blueprint-900 px-4 py-3 text-sm font-semibold text-white shadow-xl shadow-blueprint-900/20 transition hover:-translate-y-0.5 hover:bg-blueprint-800"><Bot className="h-4 w-4 text-brand-300" /> Ask Buildora</button>{open && <div className="fixed bottom-20 right-6 z-40 flex h-[min(560px,calc(100vh-120px))] w-[min(390px,calc(100vw-32px))] flex-col overflow-hidden rounded-2xl border border-slate-200 bg-surface shadow-2xl shadow-slate-900/20"><div className="flex items-center gap-3 border-b border-slate-100 bg-blueprint-900 px-4 py-3 text-white"><div className="flex h-8 w-8 items-center justify-center rounded-lg bg-brand-500"><Bot className="h-4 w-4" /></div><div className="flex-1"><div className="text-sm font-semibold">Buildora Assistant</div><div className="text-[11px] text-white/50">Your tenant workspace copilot</div></div><button onClick={() => setOpen(false)} className="rounded-lg p-1.5 text-white/60 hover:bg-white/10 hover:text-white"><X className="h-4 w-4" /></button></div><div className="flex-1 space-y-3 overflow-y-auto p-4">{messages.length === 0 && <div className="rounded-xl bg-slate-50 p-4 text-sm leading-6 text-slate-500">Ask about your pipeline, inventory, collections, or what needs attention next.</div>}{messages.map((message, index) => <div key={index} className={`max-w-[90%] rounded-xl px-3 py-2 text-sm leading-5 ${message.role === 'user' ? 'ml-auto bg-brand-600 text-white' : 'bg-slate-100 text-slate-700'}`}>{message.content}</div>)}{chat.isError && <div className="rounded-xl bg-rose-50 px-3 py-2 text-xs text-rose-700">Assistant is not configured for this organization yet. An admin can add the tenant AI API key in Settings → System Config.</div>}{chat.isPending && <div className="text-xs text-slate-400">Thinking...</div>}</div><div className="border-t border-slate-100 p-3"><div className="flex items-end gap-2 rounded-xl border border-slate-200 bg-slate-50 p-2 focus-within:border-brand-300"><textarea rows={1} className="max-h-24 flex-1 resize-none bg-transparent px-1 py-1 text-sm outline-none" placeholder="Ask anything..." value={input} onChange={(e) => setInput(e.target.value)} onKeyDown={(e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); send(); } }} /><button onClick={send} className="rounded-lg bg-brand-600 p-2 text-white disabled:opacity-40" disabled={!input.trim() || chat.isPending} aria-label="Send message"><Send className="h-4 w-4" /></button></div></div></div>}</>;
}

export default function Dashboard() {
  const user = useAuth((s) => s.user); const [params] = useSearchParams();
  const role = user?.role ?? '';
  const isSales = ['SALES_AGENT', 'SALES_MANAGER', 'CHANNEL_PARTNER'].includes(role);
  const isFinance = ['FINANCE', 'FINANCE_MANAGER', 'FINANCE_EXECUTIVE'].includes(role);
  const isProject = ['PROJECT_MANAGER', 'PROJECT_EXECUTIVE'].includes(role);
  const { data, isLoading, isError } = useQuery({
    queryKey: ['dashboard-kpis', params.toString()],
    queryFn: async () => (await api.get('/dashboard/kpis', { params: Object.fromEntries(params.entries()) })).data,
  });
  const k = data ?? {};
  const metrics = useMemo<Metric[]>(() => {
    if (isFinance) return [
      { label: 'Collected this month', value: money(k.collectionsThisMonthPaise), detail: 'Receipts posted in period', icon: CircleDollarSign, tone: 'bg-emerald-50 text-emerald-700' },
      { label: 'Overdue demands', value: k.overdueDemandsCount ?? 0, detail: money(k.overdueValuePaise) + ' outstanding', icon: CalendarClock, tone: 'bg-rose-50 text-rose-700' },
      { label: 'Collection target', value: money(k.collectionsTargetPaise), detail: 'Configured monthly target', icon: TrendingUp, tone: 'bg-blue-50 text-blue-700' },
      { label: 'Active bookings', value: k.inventory?.booked ?? 0, detail: 'Units currently booked', icon: Home, tone: 'bg-amber-50 text-amber-700' },
    ];
    if (isSales) return [
      { label: 'My leads', value: k.totalLeads ?? 0, detail: `${k.conversionRate ?? 0}% conversion rate`, icon: Target, tone: 'bg-blue-50 text-blue-700' },
      { label: 'Site visits', value: `${k.siteVisitsScheduled ?? 0}`, detail: `${k.siteVisitsCompleted ?? 0} completed`, icon: CalendarClock, tone: 'bg-violet-50 text-violet-700' },
      { label: 'Pipeline value', value: money((k.pipelineByStage ?? []).reduce((sum: number, p: any) => sum + Number(p.valuePaise ?? 0), 0)), detail: 'Across active opportunities', icon: TrendingUp, tone: 'bg-amber-50 text-amber-700' },
      { label: 'Bookings', value: k.inventory?.booked ?? 0, detail: 'Units in my pipeline', icon: Home, tone: 'bg-emerald-50 text-emerald-700' },
    ];
    if (isProject) return [
      { label: 'Available inventory', value: k.inventory?.available ?? 0, detail: `${k.inventory?.booked ?? 0} booked`, icon: Home, tone: 'bg-emerald-50 text-emerald-700' },
      { label: 'Blocked units', value: k.inventory?.blocked ?? 0, detail: 'Needs project attention', icon: ClipboardCheck, tone: 'bg-amber-50 text-amber-700' },
      { label: 'Site visits', value: k.siteVisitsScheduled ?? 0, detail: `${k.siteVisitsCompleted ?? 0} completed`, icon: CalendarClock, tone: 'bg-blue-50 text-blue-700' },
      { label: 'Demand overdue', value: k.overdueDemandsCount ?? 0, detail: money(k.overdueValuePaise), icon: CircleDollarSign, tone: 'bg-rose-50 text-rose-700' },
    ];
    return [
      { label: 'Total leads', value: k.totalLeads ?? 0, detail: `${k.conversionRate ?? 0}% conversion`, icon: Target, tone: 'bg-blue-50 text-blue-700' },
      { label: 'Revenue booked', value: money(k.revenueBookedPaise), detail: `Target ${money(k.revenueTargetPaise)}`, icon: TrendingUp, tone: 'bg-emerald-50 text-emerald-700' },
      { label: 'Collections this month', value: money(k.collectionsThisMonthPaise), detail: `Target ${money(k.collectionsTargetPaise)}`, icon: CircleDollarSign, tone: 'bg-amber-50 text-amber-700' },
      { label: 'Available inventory', value: k.inventory?.available ?? 0, detail: `${k.inventory?.booked ?? 0} booked units`, icon: Home, tone: 'bg-violet-50 text-violet-700' },
    ];
  }, [isFinance, isProject, isSales, k]);
  if (isLoading) return <Spinner />;
  const inventory = [{ name: 'Available', value: k.inventory?.available ?? 0 }, { name: 'Blocked', value: k.inventory?.blocked ?? 0 }, { name: 'Booked', value: k.inventory?.booked ?? 0 }, { name: 'Registered', value: k.inventory?.registered ?? 0 }];
  const pipeline = (k.pipelineByStage ?? []).map((p: any) => ({ stage: String(p.stage).replace(/_/g, ' '), value: Number(p.valuePaise ?? 0) / 100, count: p.count }));
  const period = params.get('from') || params.get('to') ? `${params.get('from') ?? 'Start'} — ${params.get('to') ?? 'Today'}` : 'This month';
  return <div className="mx-auto max-w-[1600px]">
    <div className="mb-7 flex flex-col justify-between gap-4 lg:flex-row lg:items-end"><div><div className="mb-2 flex items-center gap-2 text-[11px] font-bold uppercase tracking-[0.17em] text-brand-700"><span className="h-1.5 w-1.5 rounded-full bg-brand-500" />{period}</div><h1 className="font-display text-3xl font-semibold tracking-tight text-slate-900 sm:text-4xl">Good morning, {user?.name?.split(' ')[0] ?? 'there'}.</h1><p className="mt-2 max-w-xl text-sm text-slate-500">Here’s the operating picture for your workspace. Focus on what needs a decision next.</p></div><div className="flex flex-wrap gap-2"><QuickAction label="New lead" to="/leads" icon={Plus} /><QuickAction label="Book a unit" to="/bookings" icon={Home} /><QuickAction label="View reports" to="/reports" icon={BarChart3} /></div></div>
    {isError && <div className="mb-5 rounded-xl border border-rose-200 bg-rose-50 px-4 py-3 text-sm text-rose-700">Dashboard data could not be loaded. Check your permissions or refresh the page.</div>}
    <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 xl:grid-cols-4">{metrics.map((metric) => <MetricCard key={metric.label} metric={metric} />)}</div>
    <div className="mt-6 grid grid-cols-1 gap-6 xl:grid-cols-[minmax(0,1.45fr)_minmax(320px,0.8fr)]"><Card className="!rounded-2xl !p-0"><div className="flex items-center justify-between border-b border-slate-100 px-5 py-4"><div><h2 className="text-sm font-semibold text-slate-800">Pipeline value</h2><p className="mt-0.5 text-xs text-slate-400">Opportunity value by stage</p></div><button className="flex items-center gap-1 text-xs font-semibold text-brand-700 hover:text-brand-800">Details <ChevronRight className="h-3.5 w-3.5" /></button></div><div className="h-72 px-3 pb-3 pt-5">{pipeline.length ? <ResponsiveContainer width="100%" height="100%"><BarChart data={pipeline} barSize={30}><XAxis dataKey="stage" tick={{ fontSize: 10, fill: '#8b938d' }} axisLine={false} tickLine={false} /><YAxis tick={{ fontSize: 10, fill: '#8b938d' }} axisLine={false} tickLine={false} tickFormatter={(v) => `₹${Math.round(v / 100000)}L`} /><Tooltip formatter={(v: number) => `₹${v.toLocaleString('en-IN')}`} cursor={{ fill: '#f7f8f7' }} /><Bar dataKey="value" fill="#b55b2f" radius={[6, 6, 0, 0]} /></BarChart></ResponsiveContainer> : <div className="flex h-full items-center justify-center text-sm text-slate-400">Pipeline data will appear as opportunities are created.</div>}</div></Card><Card className="!rounded-2xl !p-0"><div className="border-b border-slate-100 px-5 py-4"><h2 className="text-sm font-semibold text-slate-800">Inventory pulse</h2><p className="mt-0.5 text-xs text-slate-400">Live unit availability</p></div><div className="h-72 px-3 pb-3 pt-2"><ResponsiveContainer width="100%" height="100%"><PieChart><Pie data={inventory} dataKey="value" nameKey="name" innerRadius={58} outerRadius={88} paddingAngle={3}>{inventory.map((_, i) => <Cell key={i} fill={DONUT_COLORS[i]} />)}</Pie><Legend iconType="circle" wrapperStyle={{ fontSize: 11 }} /><Tooltip /></PieChart></ResponsiveContainer></div></Card></div>
    <div className="mt-6 grid grid-cols-1 gap-6 lg:grid-cols-2"><Card className="!rounded-2xl"><div className="mb-5 flex items-center justify-between"><div><h2 className="text-sm font-semibold text-slate-800">Revenue progress</h2><p className="mt-0.5 text-xs text-slate-400">Booked value against target</p></div><TrendingUp className="h-5 w-5 text-emerald-600" /></div><div className="flex items-end justify-between"><span className="text-2xl font-semibold text-slate-900">{money(k.revenueBookedPaise)}</span><span className="text-xs text-slate-400">Target {money(k.revenueTargetPaise)}</span></div><div className="mt-4 h-2 overflow-hidden rounded-full bg-slate-100"><div className="h-full rounded-full bg-brand-600 transition-all" style={{ width: `${Math.min(100, Number(k.revenueTargetPaise ?? 0) ? Number(k.revenueBookedPaise ?? 0) / Number(k.revenueTargetPaise) * 100 : 0)}%` }} /></div><div className="mt-2 text-xs text-slate-400">{Number(k.revenueTargetPaise ?? 0) ? Math.round(Number(k.revenueBookedPaise ?? 0) / Number(k.revenueTargetPaise) * 100) : 0}% of target</div></Card><Card className="!rounded-2xl"><div className="mb-4 flex items-center justify-between"><div><h2 className="text-sm font-semibold text-slate-800">Top performers</h2><p className="mt-0.5 text-xs text-slate-400">Bookings by sales owner</p></div><UsersRound className="h-5 w-5 text-blue-600" /></div><div className="space-y-2">{(k.topAgents ?? []).length ? (k.topAgents ?? []).map((a: any, i: number) => <div key={a.agentId ?? i} className="flex items-center gap-3 rounded-xl px-2 py-2 transition hover:bg-slate-50"><div className="flex h-8 w-8 items-center justify-center rounded-lg bg-slate-100 text-xs font-bold text-slate-500">{i + 1}</div><span className="flex-1 text-sm font-medium text-slate-700">{a.name ?? 'Sales owner'}</span><span className="text-sm font-semibold text-slate-900">{a.bookings ?? 0}</span></div>) : <p className="py-6 text-center text-sm text-slate-400">No performance data yet.</p>}</div></Card></div>
    <Assistant />
  </div>;
}
