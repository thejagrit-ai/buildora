import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { AlertCircle, ArrowRight, Eye, EyeOff, LockKeyhole, MapPin } from 'lucide-react';
import { api, apiErrorMessage } from '../api/client';
import { useAuth } from '../store/auth';

function BuildoraMark() {
  return <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl bg-[#d17d4d] text-white shadow-[0_7px_16px_rgba(96,48,25,.24)]" aria-label="Buildora home mark">
    <svg viewBox="0 0 32 32" className="h-7 w-7" fill="none" role="img" aria-hidden="true">
      <path d="M6 14.2 16 6l10 8.2v10.1a1.7 1.7 0 0 1-1.7 1.7H7.7A1.7 1.7 0 0 1 6 24.3V14.2Z" fill="currentColor" fillOpacity=".16" stroke="currentColor" strokeWidth="1.6" />
      <path d="M4.5 14.6 16 5l11.5 9.6M11.2 25.8v-7.1h9.6v7.1M14.2 14.1h3.6v3.6h-3.6z" stroke="currentColor" strokeWidth="1.6" strokeLinejoin="round" />
      <path d="M23.9 10.9v-3h2.4v5" stroke="currentColor" strokeWidth="1.5" strokeLinejoin="round" />
    </svg>
  </span>;
}

function CityBlueprint() {
  const buildings = [
    [0, 470, 120, 280], [118, 390, 125, 360], [246, 510, 112, 240], [362, 330, 140, 420], [506, 455, 122, 295], [632, 275, 152, 475], [788, 420, 130, 330], [922, 340, 118, 410], [1044, 475, 138, 275], [1186, 300, 155, 450], [1345, 435, 145, 315],
  ] as const;
  return <div className="pointer-events-none absolute inset-0 overflow-hidden" aria-hidden="true">
    <div className="login-skyline absolute inset-x-[-4%] bottom-0 h-[78%] min-w-[1100px]">
      <svg viewBox="0 0 1500 800" preserveAspectRatio="xMidYMax slice" className="h-full w-full">
        <defs>
          <linearGradient id="sky-fade" x1="0" x2="0" y1="0" y2="1"><stop stopColor="#193d62" stopOpacity=".15" /><stop offset="1" stopColor="#061a32" stopOpacity=".94" /></linearGradient>
          <linearGradient id="tower-glass" x1="0" x2="1" y1="0" y2="1"><stop stopColor="#6a94aa" stopOpacity=".33" /><stop offset=".55" stopColor="#254e70" stopOpacity=".56" /><stop offset="1" stopColor="#0b2443" stopOpacity=".95" /></linearGradient>
          <pattern id="blue-grid" width="40" height="40" patternUnits="userSpaceOnUse"><path d="M40 0H0V40" fill="none" stroke="#a8c6d8" strokeOpacity=".18" strokeWidth="1" /></pattern>
        </defs>
        <rect width="1500" height="800" fill="url(#sky-fade)" /><rect width="1500" height="800" fill="url(#blue-grid)" opacity=".42" />
        <g className="login-parallax-back" opacity=".22" fill="#6c9bb0">{Array.from({ length: 8 }).map((_, i) => <rect key={i} x={i * 220 - 80} y={250 + (i % 3) * 45} width="130" height="550" />)}</g>
        {buildings.map(([x, y, w, h], index) => <g key={x} className="login-building" style={{ animationDelay: `${index * 90}ms` }}><rect x={x} y={y} width={w} height={h} fill="url(#tower-glass)" stroke="#a1c3d0" strokeOpacity=".4" /><path d={`M${x} ${y}l${w / 2} -${Math.min(42, w / 3)}l${w / 2} ${Math.min(42, w / 3)}v${h}`} fill="#2e5d7c" fillOpacity=".3" stroke="#bdd5dc" strokeOpacity=".34" /><line x1={x + w * .28} x2={x + w * .28} y1={y + 4} y2={800} stroke="#c0dce2" strokeOpacity=".14" /><line x1={x + w * .72} x2={x + w * .72} y1={y + 4} y2={800} stroke="#c0dce2" strokeOpacity=".14" />{Array.from({ length: Math.max(4, Math.floor(h / 34)) }).map((_, row) => <g key={row} opacity={row % 4 === 0 ? .9 : .48}><rect x={x + 13} y={y + 20 + row * 30} width="10" height="6" rx="1" fill={index % 5 === 0 && row === 2 ? '#e6a271' : '#b8d8df'} /><rect x={x + w - 23} y={y + 20 + row * 30} width="10" height="6" rx="1" fill="#b8d8df" /><rect x={x + w / 2 - 5} y={y + 20 + row * 30} width="10" height="6" rx="1" fill="#b8d8df" /></g>)}</g>)}
        <path d="M0 800H1500" stroke="#c4dce2" strokeOpacity=".5" /><path d="M100 765H1400" stroke="#d17d4d" strokeOpacity=".65" strokeDasharray="3 12" /><path d="M160 745V680h160v65M1090 745V630h200v115" fill="none" stroke="#bad2dc" strokeOpacity=".33" strokeWidth="2" />
        <g fill="#d6e4e6" opacity=".6" fontFamily="IBM Plex Mono, monospace" fontSize="10" letterSpacing="2"><text x="80" y="790">BUILDORA / URBAN OPERATIONS</text><text x="1240" y="790">BLD—001</text></g>
      </svg>
    </div>
    <div className="absolute inset-0 bg-[radial-gradient(circle_at_50%_28%,rgba(71,123,151,.3),transparent_38%),linear-gradient(180deg,rgba(5,22,43,.2),rgba(4,16,32,.78))]" />
  </div>;
}

export default function Login() {
  const [email, setEmail] = useState(''); const [password, setPassword] = useState(''); const [showPassword, setShowPassword] = useState(false); const [error, setError] = useState(''); const [loading, setLoading] = useState(false);
  const { setTokens, setUser } = useAuth(); const navigate = useNavigate();
  const submit = async (event: React.FormEvent) => { event.preventDefault(); setError(''); setLoading(true); try { const { data } = await api.post('/auth/login', { email, password }); setTokens(data.accessToken, data.refreshToken); const me = await api.get('/auth/me'); setUser(me.data); navigate('/'); } catch (err) { setError(apiErrorMessage(err)); } finally { setLoading(false); } };
  return <main className="relative flex min-h-screen items-center justify-center overflow-hidden bg-[#071a31] px-4 py-8 sm:px-8"><CityBlueprint /><div className="pointer-events-none absolute left-[9%] top-[14%] hidden items-center gap-2 font-mono text-[10px] uppercase tracking-[.24em] text-white/35 lg:flex"><MapPin size={13} className="text-[#d17d4d]" /> Buildora city layer / active</div><div className="pointer-events-none absolute bottom-6 right-8 hidden font-mono text-[10px] tracking-[.2em] text-white/30 sm:block">PROPERTY OPERATIONS SYSTEM</div>
    <form onSubmit={submit} className="relative z-10 w-full max-w-[440px] rounded-[26px] border border-white/50 bg-[#fffefa]/[.96] p-7 shadow-[0_30px_100px_rgba(0,0,0,.34)] backdrop-blur-xl sm:p-10"><div className="mb-9 flex items-center justify-between"><div className="flex items-center gap-3"><BuildoraMark /><div><div className="font-display text-xl tracking-wide text-slate-900">BUILDORA</div><div className="font-mono text-[9px] uppercase tracking-[.28em] text-slate-400">Property operations</div></div></div><div className="hidden items-center gap-2 rounded-full border border-emerald-200 bg-emerald-50 px-2.5 py-1.5 text-[10px] font-medium text-emerald-700 sm:flex"><span className="h-1.5 w-1.5 rounded-full bg-emerald-500" /> Secure</div></div><div className="mb-8"><p className="font-mono text-[10px] uppercase tracking-[.22em] text-brand-600">Workspace access</p><h1 className="mt-3 font-display text-[2.4rem] font-medium leading-none tracking-[-.03em] text-slate-900">Welcome back.</h1><p className="mt-3 text-sm leading-6 text-slate-500">Sign in to continue managing your property portfolio.</p></div>{error && <div className="mb-5 flex items-start gap-2 rounded-xl border border-rose-200 bg-rose-50 px-3.5 py-3 text-sm text-rose-700" role="alert"><AlertCircle className="mt-0.5 h-4 w-4 shrink-0" /><span>{error}</span></div>}<div className="space-y-5"><label className="block"><span className="label text-slate-600">Work email</span><input className="input h-12 rounded-xl border-slate-300 bg-white px-3.5 transition hover:border-slate-400 focus:border-brand-500 focus:ring-4 focus:ring-brand-100" autoComplete="email" type="email" value={email} onChange={(event) => setEmail(event.target.value)} required /></label><label className="block"><span className="label text-slate-600">Password</span><div className="relative"><input className="input h-12 rounded-xl border-slate-300 bg-white px-3.5 pr-11 transition hover:border-slate-400 focus:border-brand-500 focus:ring-4 focus:ring-brand-100" autoComplete="current-password" type={showPassword ? 'text' : 'password'} value={password} onChange={(event) => setPassword(event.target.value)} required /><button type="button" onClick={() => setShowPassword((value) => !value)} className="absolute inset-y-0 right-0 flex w-11 items-center justify-center rounded-r-xl text-slate-400 transition hover:text-slate-700 focus-visible:text-brand-700" aria-label={showPassword ? 'Hide password' : 'Show password'}>{showPassword ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}</button></div></label><button className="group flex h-12 w-full items-center justify-center gap-2 rounded-xl bg-brand-600 text-sm font-semibold text-white shadow-[0_8px_18px_rgba(181,91,47,.22)] transition hover:-translate-y-0.5 hover:bg-brand-700 hover:shadow-[0_14px_28px_rgba(181,91,47,.3)] active:translate-y-0 disabled:pointer-events-none disabled:opacity-60" disabled={loading}>{loading ? 'Signing in…' : <>Sign in <ArrowRight className="h-4 w-4 transition-transform group-hover:translate-x-0.5" /></>}</button></div><div className="mt-8 flex items-center gap-2 border-t border-slate-200 pt-5 text-xs leading-5 text-slate-400"><LockKeyhole className="h-3.5 w-3.5 shrink-0" /> Your session is protected and expires automatically.</div></form>
  </main>;
}
