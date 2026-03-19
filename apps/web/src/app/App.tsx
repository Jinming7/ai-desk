import { Navigate, Outlet, Route, Routes, useLocation, useParams } from "react-router-dom";
import { AgentRouteGuard } from "../components/AgentRouteGuard";
import { TopNav } from "../components/TopNav";
import { AgentDashboardPage } from "../pages/AgentDashboardPage";
import { AgentTicketDetailPage } from "../pages/AgentTicketDetailPage";
import { OnesSyncConfigPage } from "../pages/OnesSyncConfigPage";
import { PortalPage } from "../pages/PortalPage";
import { RequestsPage } from "../pages/RequestsPage";
import { TicketDetailPage } from "../pages/TicketDetailPage";
import { customerRoutePaths, internalRoutePaths } from "./route-map";

function CustomerShell() {
  return (
    <div className="min-h-screen">
      <TopNav mode="customer" />
      <Outlet />
    </div>
  );
}

function InternalShell() {
  const location = useLocation();
  return (
    <div className="min-h-screen">
      <TopNav mode="internal" />
      <AgentRouteGuard requestedPath={location.pathname}>
        <Outlet />
      </AgentRouteGuard>
    </div>
  );
}

function LegacyAgentTicketRedirect() {
  const { id } = useParams();
  return <Navigate to={id ? `/support/tickets/${id}` : "/support"} replace />;
}

export function App() {
  return (
    <Routes>
      <Route element={<CustomerShell />}>
        <Route path={customerRoutePaths[0]} element={<PortalPage />} />
        <Route path={customerRoutePaths[1]} element={<RequestsPage />} />
        <Route path={customerRoutePaths[2]} element={<TicketDetailPage />} />
      </Route>

      <Route element={<InternalShell />}>
        <Route path={internalRoutePaths[0]} element={<AgentDashboardPage />} />
        <Route path={internalRoutePaths[1]} element={<AgentTicketDetailPage />} />
        <Route path={internalRoutePaths[2]} element={<OnesSyncConfigPage />} />
        <Route path="/support/admin/ones-sync" element={<Navigate to="/support/admin/configuration" replace />} />
        <Route path="/agent" element={<Navigate to="/support" replace />} />
        <Route path="/agent/tickets/:id" element={<LegacyAgentTicketRedirect />} />
      </Route>

      <Route path="*" element={<Navigate to="/" replace />} />
    </Routes>
  );
}
