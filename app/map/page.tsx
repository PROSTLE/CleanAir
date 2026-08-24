import Navbar from "@/components/shared/Navbar";
import GoogleHotspotMap from "@/components/map/GoogleHotspotMap";

export default function MapPage() {
  return (
    <main className="app-page-shell">
      <div className="sv-navbar-wrap" style={{ zIndex: 200 }}>
        <div className="app-page-container" style={{ paddingTop: 0 }}>
          <Navbar />
        </div>
      </div>
      <div className="app-page-container app-page-content map-page-content">
        <GoogleHotspotMap />
      </div>
    </main>
  );
}
