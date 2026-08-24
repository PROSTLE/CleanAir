import DashboardView from "@/components/dashboard/DashboardView";
import Navbar from "@/components/shared/Navbar";

export default function DashboardPage() {
  return (
    <main className="app-page-shell">
      <div className="sv-navbar-wrap" style={{ zIndex: 200 }}>
        <div className="app-page-container" style={{ paddingTop: 0 }}>
          <Navbar />
        </div>
      </div>
      <div className="app-page-container app-page-content">
        <DashboardView />
      </div>
    </main>
  );
}
