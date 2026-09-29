import Navbar from "@/components/shared/Navbar";
import ZoneView from "@/components/zone/ZoneView";

export default async function ZonePage({ params }: { params: Promise<{ cell: string }> }) {
  const { cell } = await params;
  return (
    <main className="app-page-shell">
      <div className="sv-navbar-wrap" style={{ zIndex: 200 }}>
        <div className="app-page-container" style={{ paddingTop: 0 }}>
          <Navbar />
        </div>
      </div>
      <div className="app-page-container app-page-content">
        <ZoneView cell={cell.trim().toLowerCase()} />
      </div>
    </main>
  );
}
