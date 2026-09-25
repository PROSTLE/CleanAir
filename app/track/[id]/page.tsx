import Navbar from "@/components/shared/Navbar";
import TrackView from "@/components/report/TrackView";

export default async function TrackPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  return (
    <main className="app-page-shell">
      <div className="sv-navbar-wrap" style={{ zIndex: 200 }}>
        <div className="app-page-container" style={{ paddingTop: 0 }}>
          <Navbar />
        </div>
      </div>
      <div className="app-page-container app-page-content">
        <TrackView reportId={id} />
      </div>
    </main>
  );
}
