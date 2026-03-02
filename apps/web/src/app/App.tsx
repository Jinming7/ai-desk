import { Navigate, Route, Routes } from "react-router-dom";
import { TopNav } from "../components/TopNav";
import { AgentDashboardPage } from "../pages/AgentDashboardPage";
import { PortalPage } from "../pages/PortalPage";
import { RequestsPage } from "../pages/RequestsPage";
import { TicketDetailPage } from "../pages/TicketDetailPage";

export function App() {
  return (
    <div className="min-h-screen">
      <TopNav />
      <Routes>
        <Route path="/" element={<PortalPage />} />
        <Route path="/requests" element={<RequestsPage />} />
        <Route path="/tickets/:id" element={<TicketDetailPage />} />
        <Route path="/agent" element={<AgentDashboardPage />} />
        <Route path="*" element={<Navigate to="/" replace />} />
      </Routes>
    </div>
  );
}
