#!/usr/bin/env bun
/**
 * Government meeting tracking automation for Crescent City.
 * Tracks agendas and minutes for city council, planning commission, and harbor commission.
 * Implements proper HTML parsing and change detection for monitoring updates.
 * Last run: 2026-03-14T17:09:13.120Z
 */
import { createLogger } from './logger.js';
import { computeSha256, htmlToText } from './utils.js';
import { DOMParser } from '@xmldom/xmldom';
import { join } from 'path';
import { IdempotencyStore } from './shared/idempotency.js';

const logger = createLogger('gov_meeting_monitor');

// Government meeting sources
const GOV_SOURCES = {
  'City Council': 'https://crescentcity.org/government/city-council/agendas',
  'Planning Commission': 'https://crescentcity.org/government/planning-commission/agendas',
  'Harbor Commission': 'https://crescentcity.org/government/harbor-commission/agendas'
};

/**
 * Persistent change-detection index (id = meeting link, hash = content hash).
 * Was previously an in-memory-only Map (PROCESSED_MEETING_CACHE) that never
 * survived across separate CLI invocations, so every run silently treated
 * every item as new — this is a real cross-run idempotency fix, not just a
 * refactor. Cap of 500 preserved from the prior in-memory cache's own limit.
 *
 * Lives under output/state/, NOT output/gov_meetings/ — colocating it with
 * the batch output broke tests/gov_meeting_monitor.test.ts's naive "sort
 * output/gov_meetings/*.json and take the last" lookup, since
 * "seen-meetings.json" sorts alphabetically after every "gov_meetings-*"
 * timestamped file and has a different (non-batch) shape.
 */
const MEETING_CACHE_PATH = join(process.cwd(), 'output', 'state', 'gov-meetings-seen.json');
const meetingCache = new IdempotencyStore(MEETING_CACHE_PATH, 500);

// Keywords for filtering relevant meeting items
const MEETING_KEYWORDS = [
  'agenda',
  'minutes',
  'meeting',
  'resolution',
  'ordinance',
  'budget',
  'tsunami',
  'harbor',
  'fishing',
  'emergency',
  'evacuation',
  'zoning',
  'permit',
  'development',
  'infrastructure',
  'safety',
  'public hearing',
  'comment',
  'vote',
  'approval',
  'denial',
  'continued'
];

/**
 * Generate a hash for content to detect changes.
 *
 * Was previously declared to return `string` while actually returning the
 * unawaited `computeSha256(...)` Promise object itself — `tsc --noEmit`
 * confirms this was a genuine pre-existing type error (TS2322), and at
 * runtime it meant every "hash" was a fresh Promise instance, so the
 * `cached.hash !== hash` change-detection comparison two Promise objects
 * were (by reference) essentially always unequal — change detection was
 * silently non-functional. Fixed by making this properly async/awaited.
 */
async function generateContentHash(content: string): Promise<string> {
  return computeSha256(content.trim());
}

/**
 * Fetch and parse a government meeting page using proper HTML parsing
 */
export async function fetchGovMeetings(url: string, sourceName: string): Promise<Array<{title: string, link: string, date: string, content: string, hash: string}>> {
  try {
    logger.info(`Fetching government meetings from ${sourceName}`, { url });
    
    const response = await fetch(url);
    if (!response.ok) {
      throw new Error(`HTTP ${response.status}: ${response.statusText}`);
    }
    
    const htmlText = await response.text();
    
    // Parse HTML with DOMParser
    const parser = new DOMParser();
    const doc = parser.parseFromString(htmlText, "text/html");
    
    // Check for parsing errors
    if (doc.getElementsByTagName("parsererror").length > 0) {
      throw new Error('Failed to parse HTML');
    }
    
    const items: Array<{title: string, link: string, date: string, content: string, hash: string}> = [];
    const seenLinks = new Set<string>();
    
    // Look for common meeting document patterns in the parsed DOM
    // Pattern 1: Look for links in common containers (lists, tables, divs)
    const linkElements = doc.getElementsByTagName("a");
    
    for (let i = 0; i < linkElements.length; i++) {
      const linkEl = linkElements[i];
      const href = linkEl.getAttribute("href");
      const title = linkEl.textContent?.replace(/\s+/g, ' ').trim() || '';
      
      if (!href || !title) continue;
      
      // Skip if we've already seen this link in this fetch
      if (seenLinks.has(href)) continue;
      seenLinks.add(href);
      
      // Check if the title or surrounding text contains meeting keywords
      const fullText = (title + ' ' + linkEl.parentElement?.textContent?.toLowerCase() || '').toLowerCase();
      const isMeetingRelated = MEETING_KEYWORDS.some(keyword => 
        fullText.includes(keyword.toLowerCase())
      );
      
      if (isMeetingRelated) {
        // Try to extract a date from the title or nearby text
        let date = '';
        const datePatterns = [
          /\b\d{1,2}[\/\-]\d{1,2}[\/\-]\d{2,4}\b/,
          /\b\d{4}[\-\/]\d{1,2}[\-\/]\d{1,2}\b/,
          /\b(Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)[\s\-]\d{1,2},?\s*\d{4}\b/i,
          /\b\d{1,2}\s+(Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)[\s\-]\d{4}\b/i
        ];
        
        const searchText = title + ' ' + (linkEl.parentElement?.textContent || '');
        for (const pattern of datePatterns) {
          const match = searchText.match(pattern);
          if (match) {
            date = match[0];
            break;
          }
        }
        
        // Get some surrounding content for context (limited to avoid huge content)
        let content = '';
        const parent = linkEl.parentElement;
        if (parent) {
          // Get text content of parent element, limited length
          content = htmlToText(parent.textContent || '').substring(0, 1000);
        }
        
        // Generate hash for change detection
        const hashContent = `${title}|${href}|${date}|${content}`;
        const hash = await generateContentHash(hashContent);

        items.push({
          title,
          link: href.startsWith('http') ? href : new URL(href, url).toString(),
          date,
          content,
          hash
        });
      }
    }

    // Pattern 2: Look for specific meeting containers (common in government sites)
    const containers = [
      ...doc.getElementsByClassName('meeting'),
      ...doc.getElementsByClassName('agenda'),
      ...doc.getElementsByClassName('minutes'),
      ...doc.getElementsByClassName('event'),
      ...doc.querySelectorAll('.calendar-event'),
      ...doc.querySelectorAll('[id*="meeting"]'),
      ...doc.querySelectorAll('[class*="meeting"]')
    ];
    
    for (const container of containers) {
      const linksInContainer = container.getElementsByTagName('a');
      for (let i = 0; i < linksInContainer.length; i++) {
        const linkEl = linksInContainer[i];
        const href = linkEl.getAttribute("href");
        const title = linkEl.textContent?.replace(/\s+/g, ' ').trim() || '';
        
        if (!href || !title || seenLinks.has(href)) continue;
        seenLinks.add(href);
        
        const fullText = (title + ' ' + container.textContent?.toLowerCase() || '').toLowerCase();
        const isMeetingRelated = MEETING_KEYWORDS.some(keyword => 
          fullText.includes(keyword.toLowerCase())
        );
        
        if (isMeetingRelated) {
          // Extract date
          let date = '';
          const datePatterns = [
            /\b\d{1,2}[\/\-]\d{1,2}[\/\-]\d{2,4}\b/,
            /\b\d{4}[\-\/]\d{1,2}[\-\/]\d{1,2}\b/,
            /\b(Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)[\s\-]\d{1,2},?\s*\d{4}\b/i,
            /\b\d{1,2}\s+(Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)[\s\-]\d{4}\b/i
          ];
          
          const searchText = title + ' ' + container.textContent;
          for (const pattern of datePatterns) {
            const match = searchText.match(pattern);
            if (match) {
              date = match[0];
              break;
            }
          }
          
          // Get content
          let content = htmlToText(container.textContent || '').substring(0, 1500);
          
          // Generate hash for change detection
          const hashContent = `${title}|${href}|${date}|${content}`;
          const hash = await generateContentHash(hashContent);
          
          items.push({
            title,
            link: href.startsWith('http') ? href : new URL(href, url).toString(),
            date,
            content,
            hash
          });
        }
      }
    }
    
    logger.info(`Found ${items.length} meeting-related items from ${sourceName}`, { count: items.length });
    return items;
    
  } catch (error) {
    logger.error(`Failed to fetch government meetings from ${sourceName}`, { error: error.message, url });
    return [];
  }
}

/**
 * Save meeting items to a JSON file for historical tracking with change detection
 */
export async function saveMeetingItems(items: Array<{title: string, link: string, date: string, content: string, source: string, fetchedAt: string, isNew: boolean, changed: boolean}>): Promise<void> {
  const fs = await import('fs/promises');
  const path = await import('path');
  
  const dataDir = path.join(process.cwd(), 'output', 'gov_meetings');
  try {
    await fs.mkdir(dataDir, { recursive: true });
  } catch (e) {
    // Directory might already exist
  }
  
  const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
  const filename = path.join(dataDir, `gov_meetings-${timestamp}.json`);
  
  // Separate new and changed items for better tracking
  const newItems = items.filter(item => item.isNew);
  const changedItems = items.filter(item => item.changed && !item.isNew);
  const unchangedItems = items.filter(item => !item.changed && !item.isNew);
  
  const data = {
    fetchedAt: new Date().toISOString(),
    totalItems: items.length,
    newItems: newItems.length,
    changedItems: changedItems.length,
    unchangedItems: unchangedItems.length,
    itemsBySource: {}, // Will fill below
    items: items
  };
  
  // Count items by source
  items.forEach(item => {
    data.itemsBySource[item.source] = (data.itemsBySource[item.source] || 0) + 1;
  });
  
  await fs.writeFile(filename, JSON.stringify(data, null, 2));
  logger.info(`Saved meeting items to ${filename}`);
  
  if (newItems.length > 0) {
    logger.info(`Found ${newItems.length} NEW meeting items`);
  }
  if (changedItems.length > 0) {
    logger.info(`Found ${changedItems.length} CHANGED meeting items`);
  }
}

/**
 * Main government meeting monitoring function with change detection
 */
export interface GovMeetingItem {
  title: string;
  link: string;
  date: string;
  content: string;
  source: string;
  fetchedAt: string;
  isNew: boolean;
  changed: boolean;
}

export async function monitorGovMeetings(): Promise<GovMeetingItem[]> {
  logger.info('=== Starting Crescent City Government Meeting Monitoring ===');

  // Load the persistent change-detection index (shared store — this is what
  // gives cross-run idempotency; the prior in-memory Map never had it)
  await meetingCache.load();

  const allItems: GovMeetingItem[] = [];

  // Fetch from each government source
  for (const [sourceName, url] of Object.entries(GOV_SOURCES)) {
    try {
      const items = await fetchGovMeetings(url, sourceName);
      for (const item of items) {
        // Check for changes
        const changeResult = meetingCache.seen(item.link, item.hash);

        allItems.push({
          ...item,
          source: sourceName,
          fetchedAt: new Date().toISOString(),
          isNew: changeResult.isNew,
          changed: changeResult.changed
        });
      }
    } catch (error) {
      logger.error(`Error processing ${sourceName}`, { error: error.message });
    }
  }

  // Persist the updated change-detection index
  await meetingCache.save();

  // Sort by date (newest first), then by source
  allItems.sort((a, b) => {
    // Try to parse dates for sorting
    const dateA = a.date ? new Date(a.date.replace(/[\\/\\-]/g, '/')).getTime() : 0;
    const dateB = b.date ? new Date(b.date.replace(/[\\/\\-]/g, '/')).getTime() : 0;
    
    if (dateA !== dateB) {
      return dateB - dateA; // Newest first
    }
    return a.source.localeCompare(b.source); // Then by source name
  });
  
  // Save the results
  if (allItems.length > 0) {
    await saveMeetingItems(allItems);
    logger.info(`Government meeting monitoring complete: ${allItems.length} items found`);
    
    // Log summary
    const newCount = allItems.filter(item => item.isNew).length;
    const changedCount = allItems.filter(item => item.changed && !item.isNew).length;
    
    if (newCount > 0) {
      logger.info(`Found ${newCount} NEW meeting items`);
    }
    if (changedCount > 0) {
      logger.info(`Found ${changedCount} CHANGED meeting items`);
    }
    
    // Log the top 3 items for immediate visibility (prioritizing new/changed)
    const priorityItems = [...allItems.filter(item => item.isNew || item.changed), ...allItems.filter(item => !(item.isNew || item.changed))];
    for (let i = 0; i < Math.min(3, priorityItems.length); i++) {
      const item = priorityItems[i];
      logger.info(`Top meeting item ${i+1}:`, {
        title: item.title,
        source: item.source,
        date: item.date || 'No date',
        status: item.isNew ? 'NEW' : item.changed ? 'CHANGED' : 'UNCHANGED'
      });
    }
  } else {
    logger.warn('No government meeting items found in this cycle');
  }

  logger.info('=== Government Meeting Monitoring Complete ===');
  return allItems;
}

// Run the monitoring if this script is executed directly
if (import.meta.main) {
  monitorGovMeetings().catch(error => {
    logger.error('Government meeting monitoring failed', { error: error.message });
    process.exit(1);
  });
}