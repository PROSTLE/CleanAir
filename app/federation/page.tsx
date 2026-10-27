import FederationView from "@/components/federation/FederationView";
import Navbar from "@/components/shared/Navbar";

export const metadata = {
  title: "Federation · VayuSetu",
  description: "Transboundary smoke advisories and open data feeds shared between cities and states.",
};

export default function FederationPage() {
  return (
    <main className="app-page-shell">
      <div className="sv-navbar-wrap" style={{ zIndex: 200 }}>
        <div className="app-page-container" style={{ paddingTop: 0 }}>
          <Navbar />
        </div>
      </div>
      <div className="app-page-container app-page-content">
        <FederationView />
      </div>
    </main>
  );
}
