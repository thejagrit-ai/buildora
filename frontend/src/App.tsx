import { Navigate, Route, Routes } from 'react-router-dom';
import { useAuth } from './store/auth';
import Layout from './components/Layout';
import Login from './pages/Login';
import Dashboard from './pages/Dashboard';
import Campaigns from './pages/Campaigns';
import Leads from './pages/Leads';
import Accounts from './pages/Accounts';
import Opportunities from './pages/Opportunities';
import SiteVisits from './pages/SiteVisits';
import Inventory from './pages/Inventory';
import Bookings from './pages/Bookings';
import Finance from './pages/Finance';
import Quotations from './pages/Quotations';
import Reports from './pages/Reports';
import SettingsPage from './pages/Settings';

function RequireAuth({ children }: { children: JSX.Element }) {
  const token = useAuth((s) => s.accessToken);
  return token ? children : <Navigate to="/login" replace />;
}

export default function App() {
  return (
    <Routes>
      <Route path="/login" element={<Login />} />
      <Route
        element={
          <RequireAuth>
            <Layout />
          </RequireAuth>
        }
      >
        <Route path="/" element={<Dashboard />} />
        <Route path="/campaigns" element={<Campaigns />} />
        <Route path="/campaigns/:id" element={<Campaigns />} />
        <Route path="/leads" element={<Leads />} />
        <Route path="/leads/:id" element={<Leads />} />
        <Route path="/accounts" element={<Accounts />} />
        <Route path="/accounts/:id" element={<Accounts />} />
        <Route path="/opportunities" element={<Opportunities />} />
        <Route path="/opportunities/:id" element={<Opportunities />} />
        <Route path="/site-visits" element={<SiteVisits />} />
        <Route path="/inventory" element={<Inventory />} />
        <Route path="/inventory/:id" element={<Inventory />} />
        <Route path="/bookings" element={<Bookings />} />
        <Route path="/bookings/:id" element={<Bookings />} />
        <Route path="/finance" element={<Finance />} />
        <Route path="/quotations" element={<Quotations />} />
        <Route path="/reports" element={<Reports />} />
        <Route path="/settings" element={<SettingsPage />} />
      </Route>
      <Route path="*" element={<Navigate to="/" replace />} />
    </Routes>
  );
}
