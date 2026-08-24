import os
import re
from pathlib import Path

def extract_strings_from_tsx(filepath):
    content = Path(filepath).read_text()
    
    # Very basic regex for finding JSX text and strings
    # This won't be perfect but gives a good starting point
    jsx_text = re.findall(r'>([^<{}]+)<', content)
    strings = re.findall(r'(["\'])(.*?)\1', content)
    
    results = []
    for text in jsx_text:
        cleaned = text.strip()
        if cleaned and not re.match(r'^[A-Za-z0-9_-]+$', cleaned) and len(cleaned) > 2:
            results.append(cleaned)
            
    return results

files = [
    "app/forecast/page.tsx", "app/dashboard/page.tsx", "app/map/page.tsx",
    "app/layout.tsx", "app/report/page.tsx", "app/page.tsx",
    "components/forecast/ForecastChart.tsx", "components/forecast/AQIBadge.tsx",
    "components/Hero.tsx", "components/landing/HowItWorks.tsx",
    "components/landing/HeroSection.tsx", "components/landing/JurySnapshot.tsx",
    "components/landing/HotspotPreview.tsx", "components/shared/Navbar.tsx",
    "components/shared/CommandCenterTabs.tsx", "components/map/GoogleHotspotMap.tsx",
    "components/report/ReportPortal.tsx", "components/report/ReportLocationPicker.tsx",
    "components/command/CommandCenter.tsx"
]

for f in files:
    try:
        strings = extract_strings_from_tsx(f)
        if strings:
            print(f"\n--- {f} ---")
            for s in set(strings):
                print(s)
    except:
        pass
