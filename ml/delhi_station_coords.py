"""
Manual lat/lng mapping for Delhi CPCB monitoring stations (DL001-DL038).

Coordinates are approximate station-area centroids based on publicly known
locations of these monitoring stations (they are fixed, well-documented sites
run by DPCC/CPCB/IMD). Precision is sufficient for H3 res-8 hexagon assignment
(~0.7 sq km cells) - exact rooftop-level precision is not required.
"""

DELHI_STATION_COORDS = {
    "DL001": {"name": "Alipur, Delhi - DPCC", "lat": 28.8156, "lng": 77.1519},
    "DL002": {"name": "Anand Vihar, Delhi - DPCC", "lat": 28.6469, "lng": 77.3152},
    "DL003": {"name": "Ashok Vihar, Delhi - DPCC", "lat": 28.6953, "lng": 77.1817},
    "DL004": {"name": "Aya Nagar, Delhi - IMD", "lat": 28.4709, "lng": 77.1198},
    "DL005": {"name": "Bawana, Delhi - DPCC", "lat": 28.7762, "lng": 77.0512},
    "DL006": {"name": "Burari Crossing, Delhi - IMD", "lat": 28.7649, "lng": 77.2020},
    "DL007": {"name": "CRRI Mathura Road, Delhi - IMD", "lat": 28.5510, "lng": 77.2740},
    "DL008": {"name": "DTU, Delhi - CPCB", "lat": 28.7500, "lng": 77.1170},
    "DL009": {"name": "Dr. Karni Singh Shooting Range, Delhi - DPCC", "lat": 28.5330, "lng": 77.2860},
    "DL010": {"name": "Dwarka-Sector 8, Delhi - DPCC", "lat": 28.5710, "lng": 77.0730},
    "DL011": {"name": "East Arjun Nagar, Delhi - CPCB", "lat": 28.6620, "lng": 77.2910},
    "DL012": {"name": "IGI Airport (T3), Delhi - IMD", "lat": 28.5562, "lng": 77.1000},
    "DL013": {"name": "IHBAS, Dilshad Garden, Delhi - CPCB", "lat": 28.6810, "lng": 77.3160},
    "DL014": {"name": "ITO, Delhi - CPCB", "lat": 28.6285, "lng": 77.2405},
    "DL015": {"name": "Jahangirpuri, Delhi - DPCC", "lat": 28.7280, "lng": 77.1680},
    "DL016": {"name": "Jawaharlal Nehru Stadium, Delhi - DPCC", "lat": 28.5825, "lng": 77.2340},
    "DL017": {"name": "Lodhi Road, Delhi - IMD", "lat": 28.5910, "lng": 77.2270},
    "DL018": {"name": "Major Dhyan Chand National Stadium, Delhi - DPCC", "lat": 28.6117, "lng": 77.2370},
    "DL019": {"name": "Mandir Marg, Delhi - DPCC", "lat": 28.6360, "lng": 77.2010},
    "DL020": {"name": "Mundka, Delhi - DPCC", "lat": 28.6820, "lng": 77.0290},
    "DL021": {"name": "NSIT Dwarka, Delhi - CPCB", "lat": 28.6090, "lng": 77.0330},
    "DL022": {"name": "Najafgarh, Delhi - DPCC", "lat": 28.6090, "lng": 76.9790},
    "DL023": {"name": "Narela, Delhi - DPCC", "lat": 28.8520, "lng": 77.0910},
    "DL024": {"name": "Nehru Nagar, Delhi - DPCC", "lat": 28.5670, "lng": 77.2510},
    "DL025": {"name": "North Campus, DU, Delhi - IMD", "lat": 28.6870, "lng": 77.2100},
    "DL026": {"name": "Okhla Phase-2, Delhi - DPCC", "lat": 28.5310, "lng": 77.2710},
    "DL027": {"name": "Patparganj, Delhi - DPCC", "lat": 28.6230, "lng": 77.2910},
    "DL028": {"name": "Punjabi Bagh, Delhi - DPCC", "lat": 28.6740, "lng": 77.1310},
    "DL029": {"name": "Pusa, Delhi - DPCC", "lat": 28.6400, "lng": 77.1600},
    "DL030": {"name": "Pusa, Delhi - IMD", "lat": 28.6400, "lng": 77.1600},
    "DL031": {"name": "R K Puram, Delhi - DPCC", "lat": 28.5650, "lng": 77.1860},
    "DL032": {"name": "Rohini, Delhi - DPCC", "lat": 28.7330, "lng": 77.1200},
    "DL033": {"name": "Shadipur, Delhi - CPCB", "lat": 28.6520, "lng": 77.1580},
    "DL034": {"name": "Sirifort, Delhi - CPCB", "lat": 28.5510, "lng": 77.2160},
    "DL035": {"name": "Sonia Vihar, Delhi - DPCC", "lat": 28.7150, "lng": 77.2470},
    "DL036": {"name": "Sri Aurobindo Marg, Delhi - DPCC", "lat": 28.5580, "lng": 77.1980},
    "DL037": {"name": "Vivek Vihar, Delhi - DPCC", "lat": 28.6720, "lng": 77.3150},
    "DL038": {"name": "Wazirpur, Delhi - DPCC", "lat": 28.6990, "lng": 77.1660},
}