#!/usr/bin/env bun
/**
 * Canonical source inventory for Crescent City and Del Norte County.
 *
 * The registry is deliberately broader than the currently automated feeds:
 * it records authoritative online sources discovered during review, makes
 * automation gaps visible, and prevents a Pages snapshot from implying that
 * an unimplemented source was checked.  A source is only operationally
 * healthy when a monitor writes a matching SourceHealth record.
 */
import { existsSync } from "fs";
import { readFile } from "fs/promises";
import { computeSha256 } from "./utils.js";
import { paths } from "./shared/paths.js";
import { IdempotencyStore } from "./shared/idempotency.js";
import { boundedHttpFetch, redactUrl, type TransportOptions } from "./shared/transport.js";
import { errorMessage, isSourceHealthReceipt, sourceHealth, SOURCE_FETCH_TIMEOUT_MS, writeJsonAtomic } from "./shared/source_health.js";
import { withProducerScope, type ProducerOptions } from "./shared/run_scope.js";
import { MONITOR_KEYS, ALERT_MONITOR_SOURCE_NAMES } from "./alerts/composite.js";
import { NWS_ALERTS_URL, NWS_FORECAST_ZONE } from "./constants.js";
import type {
  SourceDefinition,
  SourceDiscoveryRecord,
  SourceDiscoveryReport,
  SourceHealth,
  SourceHealthStatus,
} from "./types.js";

export const SOURCE_REGISTRY_SCOPE =
  "Public online sources that publish Crescent City municipal-code, civic, meeting, local-news, emergency, environmental, transportation, harbor, and nearby public-agency information; this inventory is a coverage boundary, not a claim that every web page has been found.";

const DISCOVERY_CITATIONS = {
  city: "https://www.crescentcity.org/",
  county: "https://www.co.del-norte.ca.us/",
  mediaHub: "https://media.co.del-norte.ca.us/",
  harbor: "https://www.ccharbor.com/",
  harborLegacy: "https://ccharbor2.specialdistrict.org/board-meeting-recordings",
  transit: "https://redwoodcoasttransit.org/",
  airport: "https://www.flycrescentcity.com/airport-authority",
  parks: "https://www.nps.gov/redw/planyourvisit/visitorcenters.htm",
} as const;

function source(definition: SourceDefinition): SourceDefinition {
  return {
    ...definition,
    canonicalUrl: normalizeSourceUrl(definition.canonicalUrl),
    endpointUrl: definition.endpointUrl ? normalizeSourceUrl(definition.endpointUrl) : undefined,
    discoveredFrom: [...new Set(definition.discoveredFrom.map(normalizeSourceUrl))].sort(),
  };
}

/**
 * Stable inventory. Keep each id unique even when multiple monitors share a
 * provider or endpoint; the identity is the information source, not a fetch.
 */
export const SOURCE_REGISTRY: readonly SourceDefinition[] = [
  source({
    id: "municipal-code-ecode360", name: "Crescent City Municipal Code", kind: "municipal_code", authority: "official",
    region: "Crescent City", canonicalUrl: "https://ecode360.com/CR4919", discoveredFrom: ["https://www.crescentcity.org/"],
    collectionMode: "playwright", automation: "monitored", enabled: true, configuredMonitor: "municipal-code",
    expectedCadence: "on demand", provenance: "Official codification host linked by the project and City context.",
  }),
  source({
    id: "city-official-home", name: "City of Crescent City official site", kind: "city_official", authority: "official",
    region: "Crescent City", canonicalUrl: DISCOVERY_CITATIONS.city, discoveredFrom: [DISCOVERY_CITATIONS.city],
    collectionMode: "html", automation: "discovery-only", enabled: true, expectedCadence: "as published",
    provenance: "Official City site; broad landing page for news, departments, bids, requests, and civic notices.",
    notes: "Child navigation is inventoried as a source family until stable machine-readable endpoints are confirmed.",
  }),
  source({
    id: "city-meetings-evogov", name: "Crescent City meetings and agendas", kind: "meeting", authority: "official",
    region: "Crescent City", canonicalUrl: "https://www.crescentcity.org/meetings", endpointUrl: "https://www.crescentcity.org/meetings/get_list",
    discoveredFrom: [DISCOVERY_CITATIONS.city, "https://media.co.del-norte.ca.us/"], collectionMode: "api", automation: "monitored", enabled: true,
    configuredMonitor: "gov-meetings", expectedCadence: "daily", provenance: "EvoGov meetings endpoint; City Council and Planning Commission are filtered from the shared calendar.",
    notes: "Harbor Commission is not present in this endpoint; the Harbor source family is separately inventoried below.",
  }),
  source({
    id: "city-youtube", name: "City of Crescent City official YouTube", kind: "video", authority: "official",
    region: "Crescent City", canonicalUrl: "https://www.youtube.com/c/CityofCrescentCityCalifornia/videos", discoveredFrom: [DISCOVERY_CITATIONS.city, DISCOVERY_CITATIONS.mediaHub],
    endpointUrl: "https://www.youtube.com/feeds/videos.xml?channel_id=UCc8LIkDxscuciAFNB9yEEMA", collectionMode: "rss", automation: "monitored", enabled: true, configuredMonitor: "youtube", expectedCadence: "as published",
    provenance: "Official City video channel; Atom listing fallback is keyless, while transcript extraction uses yt-dlp when available.",
  }),
  source({
    id: "county-official-home", name: "County of Del Norte official site", kind: "county_official", authority: "official",
    region: "Del Norte County", canonicalUrl: DISCOVERY_CITATIONS.county, discoveredFrom: [DISCOVERY_CITATIONS.county],
    collectionMode: "html", automation: "discovery-only", enabled: true, expectedCadence: "as published",
    provenance: "Official county landing page for news, public health, Sheriff, emergency preparedness, planning, and services.",
  }),
  source({
    id: "county-meetings", name: "Del Norte County meetings and agendas", kind: "meeting", authority: "official",
    region: "Del Norte County", canonicalUrl: "https://www.co.del-norte.ca.us/meetings/85/", discoveredFrom: [DISCOVERY_CITATIONS.county],
    collectionMode: "html", automation: "monitored", configuredMonitor: "meetings:Del Norte County meetings and agendas", enabled: true, expectedCadence: "as published",
    provenance: "Official county meeting document links; source HTML retained by the bounded meetings connector; pagination/PDF completeness not established.",
  }),
  source({
    id: "county-planning", name: "Del Norte County Planning", kind: "county_official", authority: "official",
    region: "Del Norte County", canonicalUrl: "https://www.co.del-norte.ca.us/departments/Planning", discoveredFrom: [DISCOVERY_CITATIONS.county],
    collectionMode: "html", automation: "discovery-only", enabled: true, expectedCadence: "as published",
    provenance: "Official county Planning Department page and Planning Commission context.",
  }),
  source({
    id: "county-emergency-services", name: "Del Norte County Office of Emergency Services", kind: "alert", authority: "official",
    region: "Del Norte County", canonicalUrl: "https://www.co.del-norte.ca.us/departments/emergencyservices", discoveredFrom: [DISCOVERY_CITATIONS.county],
    collectionMode: "html", automation: "discovery-only", enabled: true, expectedCadence: "as published",
    provenance: "Official county emergency-services page; informs the discovery boundary for preparedness and response notices.",
  }),
  source({
    id: "county-city-media-hub", name: "Del Norte County and City government media hub", kind: "video", authority: "official",
    region: "Del Norte County", canonicalUrl: DISCOVERY_CITATIONS.mediaHub, discoveredFrom: [DISCOVERY_CITATIONS.city, DISCOVERY_CITATIONS.county],
    collectionMode: "html", automation: "monitored", configuredMonitor: "meetings:Del Norte County and City government media hub", enabled: true, expectedCadence: "as published",
    provenance: "Joint County/City hub linking agendas and recordings for Board of Supervisors, City Council, SWMA, and RCTA.",
    notes: "The hub identifies additional government video/calendar families not yet connected to a dedicated monitor.",
  }),
  source({
    id: "harbor-agendas", name: "Harbor Commission", kind: "meeting", authority: "official", region: "Crescent City",
    canonicalUrl: "https://www.ccharbor.com/archived-agendas", discoveredFrom: [DISCOVERY_CITATIONS.harbor], collectionMode: "html",
    automation: "monitored", configuredMonitor: "meetings:Harbor Commission", enabled: true, expectedCadence: "as published",
    provenance: "Official Harbor agenda archive; bounded document-link acquisition retains HTML custody; PDF/OCR and archive completeness remain separate acceptance.",
  }),
  source({
    id: "harbor-calendar", name: "Harbor District event calendar", kind: "meeting", authority: "official", region: "Crescent City",
    canonicalUrl: "https://www.ccharbor.com/event-calendar", discoveredFrom: [DISCOVERY_CITATIONS.harbor], collectionMode: "html",
    automation: "discovery-only", enabled: true, expectedCadence: "as published", provenance: "Official Harbor event calendar; acquired reachability alone does not prove calendar normalization.",
  }),
  source({
    id: "harbor-official-home", name: "Crescent City Harbor District", kind: "harbor", authority: "official",
    region: "Crescent City", canonicalUrl: DISCOVERY_CITATIONS.harbor, discoveredFrom: [DISCOVERY_CITATIONS.city, DISCOVERY_CITATIONS.harbor],
    collectionMode: "html", automation: "discovery-only", enabled: true, expectedCadence: "as published",
    provenance: "Official Harbor District website with current agenda, archived agendas, projects, and notices.",
  }),
  source({
    id: "harbor-news", name: "Crescent City Harbor District news", kind: "harbor", authority: "official",
    region: "Crescent City", canonicalUrl: "https://www.ccharbor.com/news", discoveredFrom: [DISCOVERY_CITATIONS.harbor],
    collectionMode: "html", automation: "discovery-only", enabled: true, expectedCadence: "as published",
    provenance: "Official Harbor District news page.",
  }),
  source({
    id: "harbor-recordings", name: "Crescent City Harbor board recordings", kind: "meeting", authority: "official",
    region: "Crescent City", canonicalUrl: DISCOVERY_CITATIONS.harborLegacy, discoveredFrom: [DISCOVERY_CITATIONS.harbor],
    collectionMode: "html", automation: "discovery-only", enabled: true, expectedCadence: "per meeting",
    provenance: "Harbor District special-district recording archive.",
  }),
  source({
    id: "harbor-updates", name: "Crescent City Harbor District updates", kind: "harbor", authority: "official",
    region: "Crescent City", canonicalUrl: "https://ccharbor2.specialdistrict.org/updates", discoveredFrom: [DISCOVERY_CITATIONS.harbor],
    collectionMode: "html", automation: "discovery-only", enabled: true, expectedCadence: "as published",
    provenance: "Harbor District special-district updates archive.",
  }),
  source({
    id: "harbor-rfps", name: "Crescent City Harbor District requests for proposals", kind: "harbor", authority: "official",
    region: "Crescent City", canonicalUrl: "https://ccharbor2.specialdistrict.org/request-for-proposals", discoveredFrom: [DISCOVERY_CITATIONS.harbor],
    collectionMode: "html", automation: "discovery-only", enabled: true, expectedCadence: "as published",
    provenance: "Harbor District special-district procurement page.",
  }),
  source({
    id: "redwood-coast-transit", name: "Redwood Coast Transit Authority", kind: "transportation", authority: "official",
    region: "Del Norte County", canonicalUrl: DISCOVERY_CITATIONS.transit, discoveredFrom: [DISCOVERY_CITATIONS.mediaHub, DISCOVERY_CITATIONS.transit],
    collectionMode: "html", automation: "discovery-only", enabled: true, expectedCadence: "as published",
    provenance: "Official transit authority site with rider alerts, routes, GTFS, and board agendas.",
  }),
  source({
    id: "crescent-city-airport-authority", name: "Del Norte County Regional Airport Authority", kind: "transportation", authority: "official",
    region: "Crescent City", canonicalUrl: DISCOVERY_CITATIONS.airport, discoveredFrom: [DISCOVERY_CITATIONS.city],
    collectionMode: "html", automation: "discovery-only", enabled: true, expectedCadence: "as published",
    provenance: "Official airport-authority board and operations page.",
  }),
  source({
    id: "nps-redwood-parks", name: "Redwood National and State Parks visitor information", kind: "reference", authority: "public_agency",
    region: "North Coast", canonicalUrl: DISCOVERY_CITATIONS.parks, discoveredFrom: [DISCOVERY_CITATIONS.county],
    collectionMode: "html", automation: "discovery-only", enabled: true, expectedCadence: "as published",
    provenance: "National Park Service public-agency visitor information relevant to the Crescent City gateway.",
  }),
  source({
    id: "caltrans-road-conditions", name: "Caltrans road conditions", kind: "transportation", authority: "public_agency",
    region: "California", canonicalUrl: "https://roads.dot.ca.gov/", discoveredFrom: [DISCOVERY_CITATIONS.city],
    collectionMode: "html", automation: "discovery-only", enabled: true, expectedCadence: "real time",
    provenance: "California Department of Transportation road-condition service used for US 101 and North Coast access.",
  }),
  source({
    id: "news-lost-coast-outpost", name: "Lost Coast Outpost", kind: "news", authority: "journalistic", region: "North Coast",
    canonicalUrl: "https://lostcoastoutpost.com/feed", discoveredFrom: ["https://lostcoastoutpost.com/"], collectionMode: "rss", automation: "monitored", enabled: true,
    configuredMonitor: "news:Lost Coast Outpost", expectedCadence: "daily", provenance: "RSS/Atom news monitor.",
  }),
  source({
    id: "news-humboldt-county", name: "Humboldt County official news", kind: "county_official", authority: "official", region: "North Coast",
    canonicalUrl: "https://humboldtgov.org/CivicAlerts.aspx", endpointUrl: "https://humboldtgov.org/RSSFeed.aspx?ModID=1&CID=All-newsflash.xml", discoveredFrom: ["https://humboldtgov.org/", "https://humboldtgov.org/rss.aspx"], collectionMode: "rss", automation: "monitored", enabled: true,
    configuredMonitor: "news:Humboldt County official news", expectedCadence: "daily", provenance: "Official Humboldt County News Flash RSS feed; current civic notices and public-safety releases.",
    notes: "The historical Humboldt Times has no current standalone feed; this official county feed covers current civic notices.",
  }),
  source({
    id: "news-kiem", name: "KIEM-TV NBC Eureka", kind: "news", authority: "journalistic", region: "North Coast",
    canonicalUrl: "https://www.redwoodnews.tv/news/", endpointUrl: "https://www.redwoodnews.tv/search/?f=rss&t=article&c=news&l=50&s=start_time&sd=desc", discoveredFrom: ["https://redwoodnews.tv/", "https://www.redwoodnews.tv/news/"], collectionMode: "rss", automation: "monitored", enabled: true,
    configuredMonitor: "news:KIEM-TV NBC Eureka", expectedCadence: "daily", provenance: "Current Redwood News/TownNews RSS endpoint for the KIEM-TV/NBC 3 newsroom.",
  }),
  source({
    id: "news-redwood-voice", name: "Redwood Voice", kind: "news", authority: "journalistic", region: "Del Norte County",
    canonicalUrl: "https://www.redwoodvoice.org/feed/", discoveredFrom: ["https://www.redwoodvoice.org/"], collectionMode: "rss", automation: "monitored", enabled: true,
    configuredMonitor: "news:Redwood Voice", expectedCadence: "daily", provenance: "RSS/Atom news monitor.",
  }),
  source({
    id: "news-north-coast-journal", name: "North Coast Journal", kind: "news", authority: "journalistic", region: "North Coast",
    canonicalUrl: "https://www.northcoastjournal.com/", endpointUrl: "https://www.northcoastjournal.com/feed/", discoveredFrom: ["https://www.northcoastjournal.com/"], collectionMode: "rss", automation: "monitored", enabled: true,
    configuredMonitor: "news:North Coast Journal", expectedCadence: "daily", provenance: "North Coast Journal RSS feed; independent Humboldt County regional reporting.",
  }),
  source({
    id: "alert-noaa-tsunami", name: "NOAA/NWS tsunami alerts", kind: "alert", authority: "public_agency", region: "Federal",
    canonicalUrl: "https://api.weather.gov/alerts/active?area=CA", discoveredFrom: [DISCOVERY_CITATIONS.county], collectionMode: "api", automation: "monitored", enabled: true,
    configuredMonitor: "alert:tsunami", expectedCadence: "real time", provenance: "NWS CAP/alerts API (tsunami Warning/Watch/Advisory events; area=CA covers all tiers).",
  }),
  source({
    id: "alert-usgs-earthquake", name: "USGS earthquake feed", kind: "alert", authority: "public_agency", region: "Federal",
    canonicalUrl: "https://earthquake.usgs.gov/earthquakes/feed/v1.0/summary/significant_hour.geojson", discoveredFrom: [DISCOVERY_CITATIONS.county], collectionMode: "api", automation: "monitored", enabled: true,
    configuredMonitor: "alert:earthquake", expectedCadence: "hourly", provenance: "USGS GeoJSON earthquake feed.",
  }),
  source({
    id: "alert-nws-weather", name: "NWS Northwest California weather alerts", kind: "alert", authority: "public_agency", region: "Federal",
    canonicalUrl: NWS_ALERTS_URL, discoveredFrom: [DISCOVERY_CITATIONS.county, "https://www.weather.gov/eka/Public_Zone_Change_2026"], collectionMode: "api", automation: "monitored", enabled: true,
    configuredMonitor: "alert:weather", expectedCadence: "real time", provenance: `NWS active-alert API for Coastal Del Norte public forecast zone ${NWS_FORECAST_ZONE}.`,
  }),
  source({
    id: "alert-noaa-tides", name: "NOAA CO-OPS Crescent City tides", kind: "alert", authority: "public_agency", region: "Federal",
    canonicalUrl: "https://api.tidesandcurrents.noaa.gov/api/prod/", endpointUrl: "https://api.tidesandcurrents.noaa.gov/api/prod/datagetter?station=9419750&product=predictions&begin_date=20260724&end_date=20260725&datum=MLLW&time_zone=lst_ldt&interval=h&units=english&format=json&application=crescent-city-intelligence", discoveredFrom: [DISCOVERY_CITATIONS.harbor], collectionMode: "api", automation: "monitored", enabled: true,
    configuredMonitor: "alert:tides", expectedCadence: "hourly", provenance: "NOAA CO-OPS station 9419750 predictions and observations.",
  }),
  source({
    id: "alert-cdfw-fishing", name: "CDFW North Coast fishing bulletins", kind: "alert", authority: "public_agency", region: "California",
    canonicalUrl: "https://wildlife.ca.gov/Fishing/Ocean/Regulations/Bulletins", discoveredFrom: [DISCOVERY_CITATIONS.harbor], collectionMode: "html", automation: "monitored", enabled: true,
    configuredMonitor: "alert:fishing", expectedCadence: "as published", provenance: "California Department of Fish and Wildlife marine bulletins.",
  }),
  source({
    id: "alert-airnow", name: "EPA AirNow Crescent City air quality", kind: "environment", authority: "public_agency", region: "Federal",
    canonicalUrl: "https://www.airnow.gov/", endpointUrl: "https://files.airnowtech.org/airnow/today/airnowlatest_pm25aqi.kml", discoveredFrom: [DISCOVERY_CITATIONS.county, "https://docs.airnowapi.org/docs/HourlyDataFactSheet.pdf"], collectionMode: "api", automation: "monitored", enabled: true,
    configuredMonitor: "alert:airquality", expectedCadence: "hourly", provenance: "EPA AirNow public KML observation product for the Crescent City-area station; optional keyed ZIP API remains supported.",
  }),
  source({
    id: "alert-calfire", name: "CAL FIRE wildfire incidents", kind: "alert", authority: "public_agency", region: "California",
    canonicalUrl: "https://www.fire.ca.gov/incidents", endpointUrl: "https://incidents.fire.ca.gov/umbraco/api/IncidentApi/List?inactive=false", discoveredFrom: [DISCOVERY_CITATIONS.county, "https://www.fire.ca.gov/incidents"], collectionMode: "api", automation: "monitored", enabled: true,
    configuredMonitor: "alert:wildfire", expectedCadence: "real time", provenance: "CAL FIRE current active-incident JSON endpoint linked from the official incident page.",
  }),
  source({
    id: "alert-ndbc-marine", name: "NOAA NDBC Crescent City marine buoys", kind: "environment", authority: "public_agency", region: "Federal",
    canonicalUrl: "https://www.ndbc.noaa.gov/data/realtime2/", discoveredFrom: [DISCOVERY_CITATIONS.harbor], collectionMode: "api", automation: "monitored", enabled: true,
    configuredMonitor: "alert:marine", expectedCadence: "real time", provenance: "NDBC realtime2 observations for buoys 46027, 46022, and 46214.",
  }),
  source({
    id: "alert-usdm-drought", name: "US Drought Monitor Del Norte statistics", kind: "environment", authority: "public_agency", region: "Federal",
    canonicalUrl: "https://usdmdataservices.unl.edu/", discoveredFrom: ["https://droughtmonitor.unl.edu/"], collectionMode: "api", automation: "monitored", enabled: true,
    configuredMonitor: "alert:drought", expectedCadence: "weekly", provenance: "USDM county statistics API: Del Norte FIPS 06015 DSCI and per-category area percentages; bounded dated queries are selected by the monitor.",
  }),
  source({
    id: "alert-pge-psps", name: "PG&E public safety power shutoff events", kind: "alert", authority: "reference", region: "California",
    canonicalUrl: "https://pgealerts.alerts.pge.com/pg-e-partners/psps-events/", discoveredFrom: ["https://www.pge.com/"], collectionMode: "playwright", automation: "monitored", enabled: true,
    configuredMonitor: "alert:psps", expectedCadence: "as published", provenance: "Official PG&E rendered PSPS events page; active events and county coverage come from the visible page. A browser/challenge failure is unavailable.",
  }),
  source({
    id: "alert-noaa-hms", name: "NOAA HMS mapped smoke polygons", kind: "environment", authority: "public_agency", region: "Federal",
    canonicalUrl: "https://satepsanone.nesdis.noaa.gov/pub/FIRE/web/HMS/Smoke_Polygons/Shapefile/", discoveredFrom: ["https://www.ospo.noaa.gov/products/land/hms.html"], collectionMode: "api", automation: "monitored", enabled: true,
    configuredMonitor: "alert:smoke", expectedCadence: "daily product", provenance: "NOAA HMS daily smoke polygon ZIP product: source product date and qualitative density; PM2.5/AQI and forecasts are unknown, not inferred.",
  }),
  source({
    id: "alert-caltrans-roads", name: "Caltrans North Coast per-route conditions", kind: "transportation", authority: "public_agency", region: "California",
    canonicalUrl: "https://roads.dot.ca.gov/?roadnumber=101", discoveredFrom: ["https://roads.dot.ca.gov/"], collectionMode: "html", automation: "monitored", enabled: true,
    configuredMonitor: "alert:roads", expectedCadence: "real time", provenance: "Official per-route text for all configured North Coast roads; one failed route makes coverage unavailable rather than implying all roads are clear.",
  }),
  source({
    id: "alert-dusd-schools", name: "Del Norte Unified school closures", kind: "alert", authority: "official", region: "Del Norte County",
    canonicalUrl: "https://www.dnusd.org/news", endpointUrl: "https://www.dnusd.org/", discoveredFrom: [DISCOVERY_CITATIONS.county], collectionMode: "html", automation: "monitored", enabled: true,
    configuredMonitor: "alert:schools", expectedCadence: "as published", provenance: "Official district landing/news/announcement pages; closure notices require parsed content and retain stated dates.",
  }),
  source({
    id: "alert-nws-marine", name: "NWS coastal waters forecast PZZ450", kind: "environment", authority: "public_agency", region: "Federal",
    canonicalUrl: "https://api.weather.gov/products/types/CWF/locations/EKA", discoveredFrom: ["https://www.weather.gov/eka/"], collectionMode: "api", automation: "monitored", enabled: true,
    configuredMonitor: "alert:marinezone", expectedCadence: "as issued", provenance: "Latest Eureka CWF product, PZZ450 coastal waters; parsed issue time and forecast periods remain forecasts, not buoy observations.",
  }),
  source({
    id: "alert-uscg-broadcasts", name: "USCG District 11 broadcast notices", kind: "alert", authority: "public_agency", region: "Federal",
    canonicalUrl: "https://www.navcen.uscg.gov/broadcast-notice-to-mariners-search-results?district=11&sector=0", discoveredFrom: ["https://www.navcen.uscg.gov/"], collectionMode: "html", automation: "monitored", enabled: true,
    configuredMonitor: "alert:uscg", expectedCadence: "as issued", provenance: "NAVCEN District 11 BNM list and message text; bounded issue-date windows and official notice identifiers, with no claim that advisory broadcasts imply an emergency.",
  }),
  source({
    id: "alert-city-permits", name: "City of Crescent City permit portal (MyGov)", kind: "city_official", authority: "official", region: "Crescent City",
    canonicalUrl: "https://public.mygov.us/crescent_city_ca", endpointUrl: "https://public.mygov.us/crescent_city_ca/module?module=pi",
    discoveredFrom: [DISCOVERY_CITATIONS.city], collectionMode: "html", automation: "monitored", enabled: true,
    configuredMonitor: "alert:permits", expectedCadence: "as published",
    provenance: "City-linked MyGov public portal Permits module; the server-rendered public permit catalog is watched. The issued-permit register is collaborator-login-gated and is NOT read.",
  }),
  source({
    id: "alert-harbor-dredging", name: "Crescent City Harbor District announcements", kind: "harbor", authority: "official", region: "Crescent City",
    canonicalUrl: "https://www.ccharbor.com/sitemap.xml",
    discoveredFrom: [DISCOVERY_CITATIONS.harbor], collectionMode: "html", automation: "monitored", enabled: true,
    configuredMonitor: "alert:dredging", expectedCadence: "as published",
    provenance: "Harbor District sitemap.xml with a dredging / marine-construction keyword filter; the site publishes no RSS (wp-json and /feed/ are disabled).",
  }),
  source({
    id: "alert-eia-fuel", name: "EIA weekly California retail gasoline price", kind: "environment", authority: "public_agency", region: "Federal",
    canonicalUrl: "https://www.eia.gov/dnav/pet/hist/LeafHandler.ashx?n=PET&s=EMM_EPM0_PTE_SCA_DPG&f=W",
    discoveredFrom: ["https://www.eia.gov/dnav/pet/pet_pri_gnd_dcws_a.htm"], collectionMode: "html", automation: "monitored", enabled: true,
    configuredMonitor: "alert:fuel", expectedCadence: "weekly",
    provenance: "EIA dnav weekly California all-grades all-formulations retail gasoline price (statewide observed average; no keyless station-level Crescent City feed exists).",
  }),
  source({
    id: "alert-pacfin-reports", name: "PacFIN reports dashboard (PSMFC)", kind: "environment", authority: "public_agency", region: "Federal",
    canonicalUrl: "https://reports.psmfc.org/pacfin/",
    discoveredFrom: [DISCOVERY_CITATIONS.harbor], collectionMode: "html", automation: "monitored", enabled: true,
    configuredMonitor: "alert:pacfin", expectedCadence: "as published",
    provenance: "PSMFC PacFIN APEX dashboard; the publicly embedded report-tree catalog is watched. Landing figures require PacFIN credentials and are NOT read.",
  }),
  source({
    id: "alert-ais-vessels", name: "Open AIS vessel positions", kind: "environment", authority: "public_agency", region: "Federal",
    canonicalUrl: "https://meri.digitraffic.fi/api/ais/v1/locations",
    discoveredFrom: ["https://www.digitraffic.fi/en/marine-traffic/"], collectionMode: "api", automation: "monitored", enabled: true,
    configuredMonitor: "alert:ais", expectedCadence: "real time",
    provenance: "Keyless open-AIS FeatureCollection feed (AIS_FEED_URL env; default digitraffic) filtered to the Del Norte watch box. The default feed does not establish local US-water coverage; an empty foreign feed is unavailable for local traffic, not evidence of calm.",
  }),
  source({
    id: "triplicate-home-reference", name: "Del Norte Triplicate", kind: "reference", authority: "journalistic", region: "Del Norte County",
    canonicalUrl: "https://www.triplicate.com/rss.xml", discoveredFrom: [DISCOVERY_CITATIONS.city], collectionMode: "rss", automation: "monitored", enabled: true,
    configuredMonitor: "triplicate", expectedCadence: "daily", provenance: "Site RSS feed (triplicate.com/rss.xml) since the 2025 Cloudflare block lifted; deep article bodies via __data.json under the reference-citation-only policy.",
    notes: "Excluded from LLM curation, embeddings, training inputs, and public article-content export.",
  }),
  source({
    id: "triplicate-news-reference", name: "Del Norte Triplicate news section", kind: "reference", authority: "journalistic", region: "Del Norte County",
    canonicalUrl: "https://www.triplicate.com/news/", discoveredFrom: ["https://www.triplicate.com/"], collectionMode: "playwright", automation: "monitored", enabled: true,
    configuredMonitor: "triplicate:deep-content", expectedCadence: "daily", provenance: "The deep reference connector discovers article links on browser-rendered section pages and optionally enriches them through bounded __data.json article endpoints; citations only.",
    notes: "Excluded from LLM curation, embeddings, training inputs, and public article-content export.",
  }),
  source({
    id: "triplicate-calendar", name: "Del Norte Triplicate community calendar", kind: "events", authority: "journalistic", region: "Del Norte County",
    canonicalUrl: "https://www.triplicate.com/calendar/__data.json", discoveredFrom: ["https://www.triplicate.com/calendar"], collectionMode: "api", automation: "monitored", enabled: true,
    configuredMonitor: "events:triplicate-calendar", expectedCadence: "daily", provenance: "SvelteKit structured calendar data (devalue __data.json); parsed deterministically, no LLM step.",
  }),
];

export function normalizeSourceUrl(value: string): string {
  try {
    const url = new URL(value.trim());
    url.hash = "";
    url.hostname = url.hostname.toLowerCase();
    for (const key of ["utm_source", "utm_medium", "utm_campaign", "utm_content", "utm_term", "ref"]) url.searchParams.delete(key);
    url.searchParams.sort();
    if (url.pathname.length > 1) url.pathname = url.pathname.replace(/\/+$/, "");
    return url.toString();
  } catch {
    return value.trim();
  }
}

function stableRegistry(): SourceDefinition[] {
  return [...SOURCE_REGISTRY]
    .map(item => ({ ...item, discoveredFrom: [...item.discoveredFrom].sort() }))
    .sort((a, b) => a.id.localeCompare(b.id));
}

export function getSourceRegistry(): SourceDefinition[] {
  return stableRegistry().map(item => ({ ...item, discoveredFrom: [...item.discoveredFrom] }));
}

/** Exact monitor-to-registry adapter; callers choose their declared source family. */
export function sourceIdForMonitor(monitor: string): string | undefined { return SOURCE_REGISTRY.find(item => item.configuredMonitor === monitor)?.id; }

export function validateSourceRegistry(registry = getSourceRegistry()): string[] {
  const errors: string[] = [];
  const ids = new Set<string>();
  const urls = new Map<string, string>();
  for (const item of registry) {
    if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(item.id)) errors.push(`invalid source id: ${item.id}`);
    if (ids.has(item.id)) errors.push(`duplicate source id: ${item.id}`);
    ids.add(item.id);
    const canonical = normalizeSourceUrl(item.canonicalUrl);
    if (!/^https?:\/\//.test(canonical)) errors.push(`invalid source URL: ${item.id}`);
    for (const value of [item.canonicalUrl, item.endpointUrl, ...item.discoveredFrom].filter((value): value is string => !!value)) {
      try { const url = new URL(value); if (!/^https?:$/.test(url.protocol) || url.username || url.password || redactUrl(value) !== url.toString()) errors.push(`credential-bearing or invalid source URL: ${item.id}`); } catch { errors.push(`invalid source URL: ${item.id}`); }
    }
    const prior = urls.get(canonical);
    if (prior) errors.push(`duplicate canonical source URL: ${canonical} (${prior}, ${item.id})`);
    urls.set(canonical, item.id);
    if (!item.name || !item.provenance || item.discoveredFrom.length === 0) errors.push(`incomplete provenance: ${item.id}`);
    if (item.referenceOnly && (item.automation !== "reference-only" || !item.notes?.includes("Excluded from"))) {
      errors.push(`reference-only policy is incomplete: ${item.id}`);
    }
    if (item.automation === "monitored" && !item.configuredMonitor) errors.push(`monitored source has no configured monitor: ${item.id}`);
  }
  return errors;
}

export async function sourceRegistryFingerprint(registry = getSourceRegistry()): Promise<string> {
  const errors = validateSourceRegistry(registry);
  if (errors.length) throw new Error(`Source registry invalid: ${errors.join("; ")}`);
  const stable = [...registry]
    .map(item => ({ ...item, discoveredFrom: [...item.discoveredFrom].sort() }))
    .sort((a, b) => a.id.localeCompare(b.id));
  return computeSha256(JSON.stringify(stable));
}

async function readHealth(path: string): Promise<SourceHealth[]> {
  try {
    const parsed = JSON.parse(await readFile(path, "utf8")) as { sources?: SourceHealth[] };
    return Array.isArray(parsed.sources) ? parsed.sources : [];
  } catch {
    return [];
  }
}

async function knownHealth(): Promise<SourceHealth[]> {
  return (await Promise.all([
    readHealth(paths.newsHealth), readHealth(paths.govMeetingsHealth), readHealth(paths.youtubeHealth),
    readHealth(paths.triplicateHealth), readHealth(paths.alertsHealth),
  ])).flat();
}

function healthFor(item: SourceDefinition, health: SourceHealth[]): SourceHealth[] {
  const idBound = health.filter(candidate => (candidate as SourceHealth & { sourceId?: string }).sourceId === item.id);
  if (idBound.length) {
    if (item.id !== "city-meetings-evogov") return idBound;
    const represented = new Set(idBound.map(candidate => candidate.source));
    // This source has two independent parser subfeeds. Migrating one receipt
    // to IDs cannot erase the other subfeed's historical failure/age.
    return [...idBound, ...health.filter(candidate => !candidate.sourceId && ["City Council", "Planning Commission"].includes(candidate.source) && !represented.has(candidate.source))];
  }
  // Explicit adapters for historical name-only receipts. URLs alone cannot bind
  // unrelated parsers which happen to share a provider landing page.
  const aliases = new Set([item.name]);
  const monitor = item.configuredMonitor;
  if (monitor?.startsWith("alert:")) {
    const index = MONITOR_KEYS.indexOf(monitor.slice(6) as typeof MONITOR_KEYS[number]);
    if (index >= 0) aliases.add(ALERT_MONITOR_SOURCE_NAMES[index]!);
  } else if (monitor?.startsWith("news:") || monitor?.startsWith("meetings:")) aliases.add(monitor.split(":").slice(1).join(":"));
  if (item.id === "city-meetings-evogov") { aliases.add("City Council"); aliases.add("Planning Commission"); }
  if (item.id === "city-youtube") aliases.add("YouTube");
  if (item.id === "triplicate-home-reference") aliases.add("Del Norte Triplicate");
  if (item.id === "triplicate-news-reference") aliases.add("Del Norte Triplicate deep content");
  return health.filter(candidate => !(candidate as SourceHealth & { sourceId?: string }).sourceId && aliases.has(candidate.source));
}

export async function probeSource(item: SourceDefinition, transport: TransportOptions = {}): Promise<SourceHealth> {
  const checkedAt = new Date().toISOString();
  const started = performance.now();
  const targetUrl = item.endpointUrl ?? item.canonicalUrl;
  try {
    const response = await boundedHttpFetch(targetUrl, {
      ...transport, maxBytes: Math.min(4 * 1024 * 1024, transport.maxBytes ?? 4 * 1024 * 1024),
      headers: { "User-Agent": "CrescentCityIntelligenceSystem/1.0 (github.com/docxology/crescent-city-intel)" },
      timeoutMs: Number(process.env.SOURCE_DISCOVERY_TIMEOUT_MS ?? SOURCE_FETCH_TIMEOUT_MS),
    });
    const durationMs = Math.round(performance.now() - started); const completedAt = new Date().toISOString();
    return {
      source: item.name,
      sourceId: item.id,
      status: response.ok ? "ok" : "unavailable",
      checkedAt: completedAt,
      fetchedAt: completedAt,
      itemCount: 0,
      url: item.endpointUrl ?? item.canonicalUrl,
      httpStatus: response.status,
      durationMs,
      provenance: "Bounded source-discovery probe; content collection remains monitor-specific.",
      ...(response.ok ? {} : { error: `HTTP ${response.status}: ${response.statusText}` }),
    };
  } catch (error) {
    return {
      source: item.name,
      sourceId: item.id,
      status: "unavailable",
      checkedAt,
      itemCount: 0,
      url: item.endpointUrl ?? item.canonicalUrl,
      durationMs: Math.round(performance.now() - started),
      error: errorMessage(error),
      provenance: "Bounded source-discovery probe; content collection remains monitor-specific.",
    };
  }
}

async function boundedProbes(items: SourceDefinition[]): Promise<SourceHealth[]> {
  const results: SourceHealth[] = [];
  let cursor = 0;
  const worker = async () => {
    while (cursor < items.length) {
      const item = items[cursor++];
      results.push(await probeSource(item));
    }
  };
  await Promise.all(Array.from({ length: Math.min(4, Math.max(1, items.length)) }, worker));
  return results;
}

export interface SourceDiscoveryEvidenceRecord extends SourceDiscoveryRecord {
  reachability: { status: SourceHealthStatus | "not-checked"; checkedAt?: string; httpStatus?: number; error?: string };
  collection: SourceHealthStatus | "partial" | "not-configured" | "not-checked";
  healthBinding: "source-id" | "explicit-legacy-alias" | "none";
  healthReceipts: Array<{ source: string; sourceId: string; status: SourceHealthStatus; checkedAt: string; fetchedAt?: string; ageMs?: number; freshness?: SourceHealth["freshness"]; error?: string }>;
}
export type SourceDiscoveryEvidenceReport = Omit<SourceDiscoveryReport, "sources"> & { sources: SourceDiscoveryEvidenceRecord[]; probe: { checked: number; unavailable: number } };

export async function buildSourceDiscoveryReport(options: {
  checkedAt?: string;
  probe?: boolean;
  health?: SourceHealth[];
  registry?: SourceDefinition[];
} = {}): Promise<SourceDiscoveryEvidenceReport> {
  const registry = (options.registry ?? getSourceRegistry()).sort((a, b) => a.id.localeCompare(b.id));
  const fingerprint = await sourceRegistryFingerprint(registry);
  const seen = new IdempotencyStore(paths.sourceDiscoverySeen);
  await seen.load();
  const previousFingerprint = seen.get("registry")?.hash || null;
  const checkedAt = options.checkedAt ?? new Date().toISOString();
  const health = options.health ?? await knownHealth();
  const probeHealth = options.probe ? await boundedProbes(registry.filter(item => item.enabled && item.automation !== "reference-only")) : [];

  const sources: SourceDiscoveryEvidenceRecord[] = registry.map(item => {
    const originals = healthFor(item, health);
    const observations = originals.map(original => {
      if (!isSourceHealthReceipt(original)) return sourceHealth(item.name, "unavailable", checkedAt, { itemCount: 0, error: "Malformed collection receipt" });
      const { source, status, checkedAt: originalCheckedAt, ...details } = original;
      const current = sourceHealth(source, status, checkedAt, details); current.checkedAt = originalCheckedAt;
      if (!original.fetchedAt && (current.status === "ok" || current.status === "empty")) { current.status = "unavailable"; current.error = "Collection receipt has no acquisition timestamp"; }
      if (!Number.isFinite(Date.parse(originalCheckedAt)) || Date.parse(originalCheckedAt) > Date.parse(checkedAt)) { current.status = "unavailable"; current.error = "Invalid or future collection check timestamp"; }
      return current;
    });
    const statuses = observations.map(observation => observation.status);
    const operationalStatus = statuses.includes("unavailable") ? "unavailable" : statuses.includes("stale") ? "stale" : statuses.includes("ok") ? "ok" : statuses.length ? "empty" : "not-checked";
    const reachable = probeHealth.find(probe => probe.source === item.name);
    const mixed = statuses.some(status => status === "ok" || status === "empty") && statuses.some(status => status === "unavailable" || status === "stale");
    return {
      ...item,
      operationalStatus,
      checkedAt: observations.map(observation => observation.checkedAt).sort().at(-1),
      itemCount: observations.reduce((count, observation) => count + observation.itemCount, 0),
      error: observations.filter(observation => observation.error).map(observation => `${observation.source}: ${observation.error}`).join("; ") || undefined,
      healthSource: observations.map(observation => observation.source).sort().join("; ") || undefined,
      reachability: reachable ? { status: reachable.status, checkedAt: reachable.checkedAt, httpStatus: reachable.httpStatus, error: reachable.error } : { status: "not-checked" },
      collection: item.automation === "monitored" ? mixed ? "partial" : operationalStatus : "not-configured",
      healthBinding: !originals.length ? "none" : originals.some(original => (original as SourceHealth & { sourceId?: string }).sourceId === item.id) ? "source-id" : "explicit-legacy-alias",
      healthReceipts: observations.map(observation => ({ source: observation.source, sourceId: item.id, status: observation.status, checkedAt: observation.checkedAt, fetchedAt: observation.fetchedAt, ageMs: observation.ageMs, freshness: observation.freshness, error: observation.error })),
    };
  });
  const countsByKind: Record<string, number> = {};
  const countsByAuthority: Record<string, number> = {};
  for (const item of registry) {
    countsByKind[item.kind] = (countsByKind[item.kind] ?? 0) + 1;
    countsByAuthority[item.authority] = (countsByAuthority[item.authority] ?? 0) + 1;
  }
  const report: SourceDiscoveryEvidenceReport = {
    schemaVersion: "1.0.0",
    generatedAt: checkedAt,
    scope: SOURCE_REGISTRY_SCOPE,
    registryFingerprint: fingerprint,
    previousFingerprint,
    changed: previousFingerprint !== fingerprint,
    sourceCount: registry.length,
    monitoredCount: registry.filter(item => item.automation === "monitored").length,
    discoveryOnlyCount: registry.filter(item => item.automation === "discovery-only").length,
    referenceOnlyCount: registry.filter(item => item.automation === "reference-only").length,
    enabledCount: registry.filter(item => item.enabled).length,
    countsByKind,
    countsByAuthority,
    coverageGaps: [
      "City and county child pages are inventoried but not yet collected by a dedicated monitor.",
      "Harbor/County document links are bounded acquisitions; archive pagination, PDF text, recordings and calendar completeness are not established.",
      "County Board of Supervisors, Solid Waste Management Authority, and Redwood Coast Transit Authority meeting streams need dedicated connectors.",
      "Probe availability does not replace parser-level validation or source-health emitted by a configured monitor.",
    ],
    sources,
    probe: { checked: probeHealth.length, unavailable: probeHealth.filter(item => item.status === "unavailable").length },
  };
  return report;
}

export async function writeSourceDiscoveryArtifacts(options: ProducerOptions & { probe?: boolean; checkedAt?: string } = {}): Promise<SourceDiscoveryEvidenceReport> {
  return withProducerScope("source-discovery", options, () => writeSourceDiscoveryArtifactsOwned(options));
}
async function writeSourceDiscoveryArtifactsOwned(options: { probe?: boolean; checkedAt?: string }): Promise<SourceDiscoveryEvidenceReport> {
  const registry = getSourceRegistry();
  const fingerprint = await sourceRegistryFingerprint(registry);
  const seen = new IdempotencyStore(paths.sourceDiscoverySeen);
  await seen.load();
  const report = await buildSourceDiscoveryReport({ ...options, registry });
  seen.record("registry", fingerprint, { sourceCount: registry.length });
  await seen.publish(paths.output, [
    { path: "source-registry.json", text: `${JSON.stringify({ schemaVersion: "1.0.0", fingerprint, sources: registry }, null, 2)}\n` },
    { path: "source-discovery.json", text: `${JSON.stringify(report, null, 2)}\n` },
  ], { signal: (await import('./shared/run_scope.js')).currentRunSignal() });
  return report;
}

if (import.meta.main) {
  const probe = Bun.argv.includes("--check");
  const errors = validateSourceRegistry();
  if (errors.length) {
    console.error(errors.join("\n"));
    process.exit(1);
  }
  const report = await writeSourceDiscoveryArtifacts({ probe });
  console.log(JSON.stringify({
    fingerprint: report.registryFingerprint,
    changed: report.changed,
    sourceCount: report.sourceCount,
    monitoredCount: report.monitoredCount,
    discoveryOnlyCount: report.discoveryOnlyCount,
    referenceOnlyCount: report.referenceOnlyCount,
    checked: report.probe.checked,
    unavailable: report.probe.unavailable,
  }, null, 2));
}
