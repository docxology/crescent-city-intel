/**
 * Scholarly context — maps crescent_city manuscript chapters to quadruplicate
 * geo-intelligence domains and geographic features.
 *
 * This file enables cross-reference: when a geo feature or domain is viewed
 * on quadruplicate.org, the corresponding crescent_city chapter anchor links
 * to the relevant scholarly analysis in the peer-reviewed history of
 * Crescent City (DOI 10.5281/zenodo.20286171).
 *
 * Architecture:
 *   Each crescent_city manuscript chapter is identified by its `[#sec:...]`
 *   anchor. The registry maps each chapter to one or more quadruplicate
 *   domain IDs and to the geographic features (anchor-relative or POI) that
 *   the chapter discusses. A chapter's `hazardDomains` and `features`
 *   arrays allow the Pages geo view and the GUI to surface scholarly links
 *   for a given hazard-domain marker or feature.
 *
 * All 46 chapters are indexed below; chapters without a direct geographic
 * or domain link carry empty domain/feature arrays (documented as
 * "non-geographic" in `focus`).
 */
import type { IntelligenceDomain } from "../types.js";

/** One crescent_city chapter cross-reference. */
export interface ScholarlyChapterRef {
  /** Markdown anchor, e.g. "sec:cascadia" for \\{#sec:cascadia}. */
  anchor: string;
  /** Human-readable chapter title. */
  title: string;
  /** Part: Space / Time / People / Ideas. */
  part: "Space" | "Time" | "People" | "Ideas";
  /** Part chapter number. */
  number: number;
  /** Quadruplicate domain IDs that this chapter informs. */
  domains: string[];
  /** Hazard domains that this chapter directly informs (subset of domains). */
  hazardDomains: string[];
  /** Named geographic features discussed (anchor-relative). */
  features: string[];
  /** Scholarly focus summary. */
  focus: string;
}

/**
 * Canonical registry mapping every crescent_city chapter to its
 * quadruplicate domain and feature cross-references.
 */
export const SCHOLARLY_REGISTRY: ScholarlyChapterRef[] = [
  // ── Part I — Space ──────────────────────────────────────────────
  {
    anchor: "sec:part_space",
    title: "Part I — Space: Geology, Ecology, and Infrastructure Scales",
    part: "Space", number: 0,
    domains: ["emergency-management", "environmental-protection", "infrastructure-services",
              "climate-environment", "tourism-recreation", "harbor-marine-operations",
              "housing-homelessness"],
    hazardDomains: ["emergency-management", "environmental-protection", "climate-environment"],
    features: ["del-norte-bounds", "city-anchor"],
    focus: "Nested-geography overview: Pacific plate boundary, Cascadia margin, Klamath-Smith watersheds, redwood forest, estuary, harbor, road network, townsite.",
  },
  {
    anchor: "sec:cascadia",
    title: "The Locked Margin: Cascadia and the Coming Megathrust",
    part: "Space", number: 1,
    domains: ["emergency-management", "environmental-protection", "climate-environment"],
    hazardDomains: ["emergency-management", "environmental-protection"],
    features: ["hazard-domain:Emergency Management", "del-norte-bounds"],
    focus: "Cascadia subduction zone: locked southern segment, 41 events in 10,000yr, ~240yr recurrence, 37% M8+ probability in 50yr, harbor resonance physics, M9 scenario, episodic tremor and slip.",
  },
  {
    anchor: "sec:sea_level_rise",
    title: "A Locked Plate, a Rising Ocean: Sea-Level Rise",
    part: "Space", number: 2,
    domains: ["climate-environment", "environmental-protection", "infrastructure-services",
              "harbor-marine-operations"],
    hazardDomains: ["climate-environment", "environmental-protection"],
    features: ["hazard-domain:Emergency Management", "del-norte-bounds"],
    focus: "Relative sea-level trend (-0.77 mm/yr at NOAA 9419750), locked-margin uplift (0.65 mm/yr), OPC 2100 median 0.42m, H++ 5.6-5.9ft, coseismic subsidence 1-2m, king-tide/storm-surge compounding, harbor/housing/seawall vulnerability.",
  },
  {
    anchor: "sec:smith_river_ecology",
    title: "The Last Free River: Smith River Ecology",
    part: "Space", number: 3,
    domains: ["environmental-protection", "climate-environment", "tourism-recreation"],
    hazardDomains: ["environmental-protection"],
    features: ["del-norte-bounds"],
    focus: "California's largest undammed river system, wild-and-scenic designation, anadromous fish habitat (Chinook, coho, steelhead), watershed protection, Smith River National Recreation Area.",
  },
  {
    anchor: "sec:redwood_parks",
    title: "The Once and Future Forest: Redwood Parks",
    part: "Space", number: 4,
    domains: ["tourism-recreation", "environmental-protection", "climate-environment"],
    hazardDomains: ["environmental-protection"],
    features: ["del-norte-bounds"],
    focus: "Redwood National & State Parks, Jedediah Smith Redwoods SP, old-growth redwood decline (~2M acres 1850 to ~75K acres 2025), fire ecology, conservation history, Tolowa Dee-ni' stewardship.",
  },
  {
    anchor: "sec:oil_spill",
    title: "Oil Spill Risk and Response",
    part: "Space", number: 5,
    domains: ["environmental-protection", "emergency-management", "harbor-marine-operations"],
    hazardDomains: ["environmental-protection", "emergency-management"],
    features: ["hazard-domain:Emergency Management", "hazard-domain:Environmental Protection"],
    focus: "Hussey Texaco tank farm rupture during 1964 tsunami, oil-spill risk from harbor fuel storage, coastal spill response capacity, NOAA trajectory modeling for Crescent City shoreline.",
  },
  {
    anchor: "sec:seawall",
    title: "Seawall Engineering and Harbor Design",
    part: "Space", number: 6,
    domains: ["infrastructure-services", "harbor-marine-operations", "environmental-protection"],
    hazardDomains: ["environmental-protection"],
    features: ["hazard-domain:Environmental Protection"],
    focus: "Dolos-armored breakwater (38t units, 1980s), Inner Boat Basin (240-slip tsunami-resistant), Beachfront Park fill, post-1964 harbor reconstruction, MARAD-linked seawall grants.",
  },
  {
    anchor: "sec:housing",
    title: "Housing on a Hazard-Constrained Land Base",
    part: "Space", number: 7,
    domains: ["housing-homelessness", "infrastructure-services"],
    hazardDomains: [],
    features: ["city-anchor"],
    focus: "Post-1964 urban renewal, affordable housing pipeline ($100M Battery Point Apartments, Redwood Downtown mixed-use, Harbor Point senior), Prohousing Designation, RHNA targets, housing+seismic+tsunami policy intersection.",
  },
  {
    anchor: "sec:transportation",
    title: "Lifeline Transportation on a Remote Coast",
    part: "Space", number: 8,
    domains: ["infrastructure-services"],
    hazardDomains: [],
    features: ["city-anchor"],
    focus: "US 101 Last Chance Grade tunnel project ($2.7B, Alternative F), US 199 wildfire closures, Crescent City Airport (CEC), Redwood Coast Transit, rural access vulnerability.",
  },

  // ── Part II — Time ──────────────────────────────────────────────
  {
    anchor: "sec:part_time",
    title: "Part II — Time: Chronology, Extraction, Disaster, and Adaptation",
    part: "Time", number: 0,
    domains: ["emergency-management", "climate-environment", "demographics-social",
              "harbor-marine-operations", "business-development", "environmental-protection"],
    hazardDomains: ["emergency-management", "climate-environment"],
    features: ["del-norte-bounds", "city-anchor"],
    focus: "Long-chronology overview: Tolowa habitation, settlement-era extraction, timber economy, fishing industry, 1964 tsunami, Pacific-wide warning policy, Tōhoku, wildfire, recent currents.",
  },
  {
    anchor: "sec:archaeology",
    title: "Before the Written Record: Archaeology of the Crescent City Coast",
    part: "Time", number: 1,
    domains: [],
    hazardDomains: [],
    features: [],
    focus: "Non-geographic: archaeological evidence classes (shell middens, lithic scatters, obsidian sourcing, faunal remains) without site disclosure. 12,000+ years of Tolowa Dee-ni' habitation.",
  },
  {
    anchor: "sec:contact",
    title: "European Contact and the Tolowa Dee-ni' Catastrophe",
    part: "Time", number: 2,
    domains: ["demographics-social"],
    hazardDomains: [],
    features: [],
    focus: "Genocidal settlement era, 1850s colonial violence, Tolowa population collapse from ~2,500 to ~150, Treaty of 1852, Smith River Reservation, forced removal.",
  },
  {
    anchor: "sec:first_american",
    title: "The First American Decade",
    part: "Time", number: 3,
    domains: [],
    hazardDomains: [],
    features: [],
    focus: "Non-geographic: 1850s American settlement, Crescent City founding (1853), county formation (1857), early governance.",
  },
  {
    anchor: "sec:gold_rush",
    title: "Gold, Klamath, and the Southern Oregon Hinterland",
    part: "Time", number: 4,
    domains: ["business-development"],
    hazardDomains: [],
    features: [],
    focus: "Klamath River gold rush, hydraulic mining impacts on Klamath estuary, southern Oregon supply routes, Crescent City as shipping point.",
  },
  {
    anchor: "sec:lumber",
    title: "The Timber Economy: From Redwood to Wood Products",
    part: "Time", number: 5,
    domains: ["business-development", "environmental-protection"],
    hazardDomains: ["environmental-protection"],
    features: [],
    focus: "Timber industry history: 1850s old-growth redwood logging, Simpson Timber, Georgia-Pacific, mill closures, habitat-conservation plan transition, contemporary second-growth landscape.",
  },
  {
    anchor: "sec:logging_technology",
    title: "Logging Technology: Steam Donkeys, Railroads, and the Modern Logger",
    part: "Time", number: 6,
    domains: ["business-development"],
    hazardDomains: [],
    features: [],
    focus: "Non-geographic: technology history of redwood logging, railroad spurs, steam donkeys, high-lead logging, truck logging, modern mechanized harvest.",
  },
  {
    anchor: "sec:fishing",
    title: "The Working Waterfront: Fishing, Crabbing, and Harbor Commerce",
    part: "Time", number: 7,
    domains: ["harbor-marine-operations", "business-development", "tourism-recreation"],
    hazardDomains: [],
    features: ["city-anchor"],
    focus: "Commercial fishing fleet, Dungeness crab (largest-value CA port), salmon closures 2023-2026, 2026 fishery reopening under in-season management, harbor district governance, PacFIN landing data.",
  },
  {
    anchor: "sec:railroad",
    title: "The Railroad Era and Its Legacy",
    part: "Time", number: 8,
    domains: ["infrastructure-services"],
    hazardDomains: [],
    features: [],
    focus: "Historical railroad infrastructure, Oregon & California Railroad, line abandonments, rail-to-truck modal shift, right-of-way legacy.",
  },
  {
    anchor: "sec:economics",
    title: "Economic History and Structural Change",
    part: "Time", number: 9,
    domains: ["business-development", "demographics-social", "housing-homelessness"],
    hazardDomains: [],
    features: [],
    focus: "Economic transition from timber/fishing to prison/harbor/tourism/service economy, 17% poverty rate, median income $35,540, Pelican Bay State Prison as largest employer (~1,000 staff).",
  },
  {
    anchor: "sec:agriculture",
    title: "Agriculture and the Smith River Valley",
    part: "Time", number: 10,
    domains: ["environmental-protection"],
    hazardDomains: [],
    features: [],
    focus: "Smith River valley agriculture, dairy operations, bulb-farming history (Easter lily bulbs), coastal grazing, wetland conversion patterns.",
  },
  {
    anchor: "sec:tsunami",
    title: "Eleven Drownings: The Killer Wave of Good Friday 1964",
    part: "Time", number: 11,
    domains: ["emergency-management", "environmental-protection", "harbor-marine-operations",
              "infrastructure-services"],
    hazardDomains: ["emergency-management", "environmental-protection"],
    features: ["hazard-domain:Emergency Management", "city-anchor"],
    focus: "1964 Alaska M9.2 earthquake, 4-wave sequence (max 6.4m/21ft), 11 deaths, 289 buildings destroyed, $76-140M (2024$), post-disaster rezoning, Beachfront Park buffer, dolos breakwater, TsunamiReady certification.",
  },
  {
    anchor: "sec:tsunami_context",
    title: "Crescent City in the Pacific Tsunami Warning System",
    part: "Time", number: 12,
    domains: ["emergency-management"],
    hazardDomains: ["emergency-management"],
    features: ["hazard-domain:Emergency Management"],
    focus: "Pacific-wide tsunami warning evolution, NOAA PTWC, DART buoy network, TsunamiReady program, Redwood Coast Tsunami Work Group, education and drill infrastructure.",
  },
  {
    anchor: "sec:tohoku",
    title: "Tōhoku 2011 and the Crescent City Harbor Response",
    part: "Time", number: 13,
    domains: ["emergency-management", "harbor-marine-operations"],
    hazardDomains: ["emergency-management"],
    features: ["hazard-domain:Emergency Management"],
    focus: "2011 Tōhoku earthquake (Mw 9.0), 14-15 kt horizontal harbor currents, 2.47m peak amplitude, harbor dock damage despite modest wave height, basin resonance behavior.",
  },
  {
    anchor: "sec:wildfire",
    title: "When the Forest Burns: Slater Fire, Smith River Complex, and Pyrodiversity",
    part: "Time", number: 14,
    domains: ["climate-environment", "public-health-safety", "infrastructure-services"],
    hazardDomains: ["climate-environment"],
    features: ["del-norte-bounds"],
    focus: "Slater Fire 2020 (157,270 acres, 440 structures), Smith River Complex 2023 (95,107 acres, 12-fire swarm), reburn dynamics, Indigenous cultural fire restoration, US 199 closures, smoke exposure health impacts.",
  },
  {
    anchor: "sec:currents",
    title: "The Active Present: Currents 2024-2026",
    part: "Time", number: 15,
    domains: ["business-development", "emergency-management", "climate-environment",
              "housing-homelessness", "infrastructure-services", "harbor-marine-operations",
              "demographics-social"],
    hazardDomains: ["emergency-management", "climate-environment"],
    features: ["city-anchor"],
    focus: "Klamath dam removal completion, Last Chance Grade tunnel selection, housing surge (292 units), Prop 218 water/sewer rates, Triplicate closure/relaunch, salmon fishery recovery, May 2026 M4.8 earthquake, Tolowa elk restoration grant.",
  },
  {
    anchor: "sec:timeline",
    title: "A Compact Chronology of Crescent City",
    part: "Time", number: 16,
    domains: ["demographics-social", "emergency-management"],
    hazardDomains: ["emergency-management"],
    features: ["city-anchor"],
    focus: "Tabular chronology from Tolowa habitation (pre-1500s) through 2026 events; key data for temporal-tag correlation across all hazard domains.",
  },

  // ── Part III — People ───────────────────────────────────────────
  {
    anchor: "sec:part_people",
    title: "Part III — People: Communities, Institutions, Sovereignty, and Public Life",
    part: "People", number: 0,
    domains: ["demographics-social", "public-safety", "education-youth",
              "public-health-safety", "housing-homelessness"],
    hazardDomains: [],
    features: ["city-anchor"],
    focus: "Community-scale overview: Tolowa Dee-ni', Nee-dash, immigrant communities, governance, county institutions, military, WWII, education, religion, demographics, healthcare.",
  },
  {
    anchor: "sec:indigenous",
    title: "Tolowa Dee-ni': The First People of the Crescent City Coast",
    part: "People", number: 1,
    domains: ["environmental-protection", "demographics-social"],
    hazardDomains: ["environmental-protection"],
    features: [],
    focus: "Tolowa Dee-ni' Nation: twelve generations, Smith River estuary stewardship, Nee-dash villages, Indigenous burning practices, Yurok-Tolowa Indigenous Marine Stewardship Area, elk habitat restoration (2026 grant).",
  },
  {
    anchor: "sec:neighboring_nations",
    title: "Yurok, Karuk, and Neighboring Tribal Nations",
    part: "People", number: 2,
    domains: ["environmental-protection", "climate-environment"],
    hazardDomains: ["environmental-protection"],
    features: [],
    focus: "Yurok Tribe, Karuk Tribe, Hoopa Valley Tribe, Klamath River restoration leadership, cultural fire programs, climate adaptation planning, tribal co-management of Redwood National Park.",
  },
  {
    anchor: "sec:immigrant",
    title: "Immigrant Communities",
    part: "People", number: 3,
    domains: ["demographics-social"],
    hazardDomains: [],
    features: [],
    focus: "Non-geographic: Portuguese, Italian, Croatian, Chinese, Japanese, Filipino, and Mexican immigrant communities in the timber, fishing, and dairy economies.",
  },
  {
    anchor: "sec:governance",
    title: "City Government and Municipal Governance",
    part: "People", number: 4,
    domains: ["business-development", "housing-homelessness", "infrastructure-services"],
    hazardDomains: [],
    features: ["city-anchor"],
    focus: "City Council, Planning Commission, Harbor Commission, general law city with elected mayor and council, municipal code (17 titles), City Manager system, budget process.",
  },
  {
    anchor: "sec:county",
    title: "County Institutions: Del Norte County",
    part: "People", number: 5,
    domains: ["demographics-social", "public-health-safety", "education-youth"],
    hazardDomains: [],
    features: ["del-norte-bounds"],
    focus: "Del Norte County Board of Supervisors, county departments, OES, HHSA, county/city relationship, special districts (SWMA, RCTA, Harbor District, Airport Authority).",
  },
  {
    anchor: "sec:military",
    title: "Military and Coast Guard on the North Coast",
    part: "People", number: 6,
    domains: ["public-safety"],
    hazardDomains: [],
    features: [],
    focus: "Non-geographic: US Coast Guard Crescent City station, WWII coastal defense, early-warning radar stations, California National Guard role in 1964 tsunami response.",
  },
  {
    anchor: "sec:wwii",
    title: "World War II and the Crescent City Home Front",
    part: "People", number: 7,
    domains: [],
    hazardDomains: [],
    features: [],
    focus: "Non-geographic: WWII-era population boom, airbase construction, coastal defense fortifications, Japanese-American incarceration impact, postwar economic transition.",
  },
  {
    anchor: "sec:education",
    title: "Education in a Remote Coastal District",
    part: "People", number: 8,
    domains: ["education-youth", "demographics-social"],
    hazardDomains: [],
    features: [],
    focus: "Del Norte Unified School District, College of the Redwoods Del Norte, school infrastructure vulnerability to tsunami/seismic hazard, K-12 funding challenges.",
  },
  {
    anchor: "sec:religion",
    title: "Religious Life and Congregations",
    part: "People", number: 9,
    domains: ["tourism-recreation"],
    hazardDomains: [],
    features: [],
    focus: "Non-geographic: churches, missions, religious diversity in a small coastal community, role of faith institutions in disaster response.",
  },
  {
    anchor: "sec:demographics",
    title: "Demographic Profile and Population Structure",
    part: "People", number: 10,
    domains: ["demographics-social", "housing-homelessness", "public-health-safety"],
    hazardDomains: [],
    features: ["city-anchor"],
    focus: "Population ~6,046 (2024 est.) including ~3,000 Pelican Bay inmates, age structure, racial/ethnic composition, poverty rate (17%), median income ($35,540), housing cost burden.",
  },
  {
    anchor: "sec:healthcare",
    title: "Healthcare and Social Services in a Rural Prison-Adjacent County",
    part: "People", number: 11,
    domains: ["public-health-safety", "demographics-social"],
    hazardDomains: [],
    features: ["city-anchor"],
    focus: "Sutter Coast Hospital (limited licensed capacity), Del Norte County HHSA, rural health access network, mental health/CARE Court coordination, wildfire smoke health impacts, EMS mutual aid with Curry County OR.",
  },

  // ── Part IV — Ideas ─────────────────────────────────────────────
  {
    anchor: "sec:part_ideas",
    title: "Part IV — Ideas: Rules, Meanings, Restoration, Memory, and Evidence",
    part: "Ideas", number: 0,
    domains: ["environmental-protection", "housing-homelessness", "business-development"],
    hazardDomains: ["environmental-protection"],
    features: ["city-anchor"],
    focus: "Planning framework overview: zoning, resilience, Klamath dam removal, Jefferson identity, modern economy, culture, arts, tourism, Klamath Knot bioregional concept.",
  },
  {
    anchor: "sec:zoning",
    title: "Zoning, Land Use, and the General Plan",
    part: "Ideas", number: 1,
    domains: ["housing-homelessness", "environmental-protection", "infrastructure-services",
              "business-development", "tourism-recreation"],
    hazardDomains: ["environmental-protection"],
    features: ["city-anchor"],
    focus: "Municipal code Title 17 (Zoning), coastal overlay district, tsunami inundation zone, General Plan update incorporating sea-level rise, housing element compliance, ADU regulations.",
  },
  {
    anchor: "sec:resilience",
    title: "Resilience as Spatial Practice",
    part: "Ideas", number: 2,
    domains: ["emergency-management", "climate-environment", "infrastructure-services",
              "housing-homelessness"],
    hazardDomains: ["emergency-management", "climate-environment"],
    features: ["hazard-domain:Emergency Management", "city-anchor"],
    focus: "Community resilience framework: multi-hazard planning (tsunami, seismic, wildfire, sea-level), preparedness as spatial practice, TsunamiReady certification, Cascadia Rising exercises, EOC coordination.",
  },
  {
    anchor: "sec:klamath",
    title: "Klamath Dam Removal: Restoration as a Regional Turning Point",
    part: "Ideas", number: 3,
    domains: ["environmental-protection", "climate-environment", "tourism-recreation"],
    hazardDomains: ["environmental-protection", "climate-environment"],
    features: ["del-norte-bounds"],
    focus: "Largest dam removal in US history (August 2024), Klamath River restoration, salmon recovery, tribal leadership (Yurok, Karuk), NOAA/CalTrout monitoring, post-dam sediment and riparian response.",
  },
  {
    anchor: "sec:jefferson",
    title: "The State of Jefferson: Regional Identity and Secession Movements",
    part: "Ideas", number: 4,
    domains: ["demographics-social"],
    hazardDomains: [],
    features: ["del-norte-bounds"],
    focus: "Non-geographic: State of Jefferson political identity, secession movement history, rural-urban tensions in California governance, regional symbol in North Coast politics.",
  },
  {
    anchor: "sec:modern_economy",
    title: "The Modern Economy: Prison, Harbor, Timber, Tourism, and Healthcare",
    part: "Ideas", number: 5,
    domains: ["business-development", "demographics-social", "housing-homelessness"],
    hazardDomains: [],
    features: [],
    focus: "Contemporary economic sectors: Pelican Bay State Prison (~1,000 staff, ~3,000 inmates), commercial fishing, timber, tourism (4M annual park visitors), healthcare, small-business retail.",
  },
  {
    anchor: "sec:culture_arts",
    title: "Culture and the Arts in a Small Coastal Town",
    part: "Ideas", number: 6,
    domains: ["tourism-recreation", "education-youth"],
    hazardDomains: [],
    features: [],
    focus: "Non-geographic: Crescent City cultural institutions, Del Norte County Historical Society, Battery Point Lighthouse museum, public art, Redwood Coast Shakespeare Festival, local music and literary scene.",
  },
  {
    anchor: "sec:tourism",
    title: "Tourism and the Gateway Economy",
    part: "Ideas", number: 7,
    domains: ["tourism-recreation", "business-development", "infrastructure-services"],
    hazardDomains: [],
    features: ["city-anchor"],
    focus: "Tourism as economic driver, Redwood National Park gateway, Battery Point Lighthouse, Smith River recreation, harbor charters, short-term rental regulations, visitor-serving commercial zoning.",
  },
  {
    anchor: "sec:klamath_knot",
    title: "The Klamath Knot: Bioregional Thinking at the Klamath Confluence",
    part: "Ideas", number: 8,
    domains: ["environmental-protection", "climate-environment", "tourism-recreation"],
    hazardDomains: ["environmental-protection", "climate-environment"],
    features: ["del-norte-bounds"],
    focus: "Klamath Knot bioregion concept (after Wallace/Muir), Klamath River watershed, Smith River, redwood forest, Klamath Mountains conifer forest, fish-gene flow, serpentine endemism, fire ecology.",
  },
  {
    anchor: "sec:conclusion",
    title: "Conclusion: The Locked Margin in Human Time",
    part: "Ideas", number: 9,
    domains: ["emergency-management", "climate-environment", "demographics-social"],
    hazardDomains: ["emergency-management", "climate-environment"],
    features: ["city-anchor", "del-norte-bounds"],
    focus: "Synthesis: nested systems of space, time, people, ideas — a small Pacific-coast town confronting twenty-first-century rebuilding and the deeper vulnerabilities the locked Cascadia margin imposes.",
  },
  {
    anchor: "sec:reproducibility",
    title: "Reproducibility and Methodological Transparency",
    part: "Ideas", number: 10,
    domains: [],
    hazardDomains: [],
    features: [],
    focus: "Non-geographic: data sources, pipeline architecture, figure generation, citation validation, reproducibility contract, evidence-class framework, audit trail and known limitations.",
  },
];

/**
 * Get all scholarly chapter references that cross-reference a given domain ID.
 */
export function chaptersForDomain(domainId: string): ScholarlyChapterRef[] {
  return SCHOLARLY_REGISTRY.filter(ref => ref.domains.includes(domainId));
}

/**
 * Get all scholarly chapter references that cross-reference a given hazard domain ID.
 */
export function hazardChaptersForDomain(domainId: string): ScholarlyChapterRef[] {
  return SCHOLARLY_REGISTRY.filter(ref => ref.hazardDomains.includes(domainId));
}

/**
 * Get all scholarly chapter references that mention a named geographic feature.
 */
export function chaptersForFeature(featureId: string): ScholarlyChapterRef[] {
  return SCHOLARLY_REGISTRY.filter(ref => ref.features.includes(featureId));
}

/**
 * Get the total number of indexed chapters.
 */
export function scholarlyChapterCount(): number {
  return SCHOLARLY_REGISTRY.length;
}
