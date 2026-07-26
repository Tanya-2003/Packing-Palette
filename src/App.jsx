import React, { useState, useEffect, useMemo, useRef } from "react";
import {
  MapPin,
  CalendarDays,
  Plane,
  Sun,
  CloudRain,
  Thermometer,
  Wind,
  Copy,
  Check,
  X,
  Plus,
  Luggage,
  Loader2,
  ChevronLeft,
  ChevronRight,
} from "lucide-react";

/* ------------------------------ date helpers ------------------------------ */
function daysBetween(startISO, endISO) {
  const start = new Date(startISO);
  const end = new Date(endISO);
  const diff = Math.round((end - start) / 86400000);
  return Math.max(diff + 1, 1);
}

/* -------------------------------- UV model -------------------------------- */
// UV isn't available from the historical weather endpoint, so it's estimated
// from latitude + season. Everything else on the weather card is real data.
function estimateUV(lat, month) {
  const absLat = Math.abs(lat);
  const phase = lat >= 0 ? month : (month + 6) % 12;
  const seasonFactor = Math.cos(((phase - 6) * Math.PI) / 6);
  let base;
  if (absLat < 15) base = 10.5;
  else if (absLat < 30) base = 9;
  else if (absLat < 45) base = 6.5;
  else base = 4;
  const spread = absLat < 15 ? 0.5 : absLat < 30 ? 1.5 : 3;
  return Math.max(1, Math.round(base + seasonFactor * spread));
}

function fallbackWeather(lat, month) {
  const absLat = Math.abs(lat);
  const phase = lat >= 0 ? month : (month + 6) % 12;
  const seasonFactor = Math.cos(((phase - 6) * Math.PI) / 6);
  const baseTemp = 30 - absLat * 0.5;
  const amplitude = 5 + absLat * 0.3;
  const high = Math.round(baseTemp + seasonFactor * amplitude);
  const low = Math.round(high - (10 + absLat * 0.1));
  return { high, low, rain: 30, uv: estimateUV(lat, month), source: "estimated" };
}

/* ------------------------------ weather (real) ----------------------------- */
async function fetchRealWeather(lat, lon, startDate, endDate) {
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const start = new Date(startDate);
  const diffDays = Math.round((start - today) / 86400000);
  const month = start.getMonth();

  // helper with retry/backoff for archive endpoints
  async function fetchWithRetry(url, attempts = 4) {
    let wait = 400;
    for (let i = 0; i < attempts; i++) {
      try {
        const res = await fetch(url);
        if (res.status === 429) {
          // rate limited; wait and retry
          await new Promise((r) => setTimeout(r, wait));
          wait *= 1.8;
          continue;
        }
        if (!res.ok) return { ok: false, status: res.status, json: null };
        const json = await res.json();
        return { ok: true, status: res.status, json };
      } catch (e) {
        await new Promise((r) => setTimeout(r, wait));
        wait *= 1.8;
      }
    }
    return { ok: false, status: 429, json: null };
  }

  try {
    // If trip starts near today, prefer forecast API (no historical)
    if (diffDays >= -1 && diffDays <= 15) {
      const url = `https://api.open-meteo.com/v1/forecast?latitude=${lat}&longitude=${lon}&start_date=${startDate}&end_date=${endDate}&daily=temperature_2m_max,temperature_2m_min,precipitation_probability_mean&timezone=auto`;
      const res = await fetch(url);
      if (!res.ok) throw new Error("forecast request failed");
      const json = await res.json();
      const avg = (arr) => arr.reduce((a, b) => a + b, 0) / arr.length;
      const high = Math.round(avg(json.daily.temperature_2m_max));
      const low = Math.round(avg(json.daily.temperature_2m_min));
      const rainArr = json.daily.precipitation_probability_mean || [];
      const rain = rainArr.length ? Math.round(avg(rainArr)) : 20;
      return { high, low, rain, uv: estimateUV(lat, month), source: "live forecast" };
    }

    // For historical averages, fetch archive years sequentially with backoff to avoid 429s
    const thisYear = today.getFullYear();
    const years = [1, 2, 3, 4, 5].map((n) => thisYear - n);
    const startMD = startDate.slice(5);
    const endMD = endDate.slice(5);

    const results = [];
    for (const y of years) {
      const ys = `${y}-${startMD}`;
      const ye = `${y}-${endMD}`;
      const url = `https://archive-api.open-meteo.com/v1/archive?latitude=${lat}&longitude=${lon}&start_date=${ys}&end_date=${ye}&daily=temperature_2m_max,temperature_2m_min,precipitation_sum&timezone=auto`;
      const r = await fetchWithRetry(url, 4);
      if (r.ok && r.json && r.json.daily) results.push(r.json.daily);
      // small delay between sequential calls to be polite to the API
      await new Promise((r) => setTimeout(r, 220));
    }

    const valid = results.filter((d) => d && d.temperature_2m_max);
    if (!valid.length) throw new Error("no historical data");

    let highs = [], lows = [], rainDays = 0, totalDays = 0;
    valid.forEach((d) => {
      highs.push(...d.temperature_2m_max.filter((v) => v != null));
      lows.push(...d.temperature_2m_min.filter((v) => v != null));
      (d.precipitation_sum || []).forEach((p) => {
        if (p == null) return;
        totalDays++;
        if (p > 1) rainDays++;
      });
    });
    const avg = (arr) => arr.reduce((a, b) => a + b, 0) / arr.length;
    const high = Math.round(avg(highs));
    const low = Math.round(avg(lows));
    const rain = totalDays ? Math.round((rainDays / totalDays) * 100) : 25;
    return { high, low, rain, uv: estimateUV(lat, month), source: "5-year historical average" };
  } catch (e) {
    return fallbackWeather(lat, month);
  }
}

/* --------------------------- destination images (real) --------------------------- */
// Uses the stable MediaWiki Action API (api.php) rather than the old RESTBase
// "page/media-list" endpoint, which Wikimedia has been deprecating/redirecting.
function isBadImageTitle(title) {
  const t = (title || "").toLowerCase();
  if (/\.svg$/.test(t)) return true;
  return /(flag|coat[_ ]of[_ ]arms|locator|map|icon|seal|symbol|logo|disambig|ambox|question_book|edit-icon|commons-logo|wiktionary|wikidata|folder)/.test(
    t
  );
}

async function getPageTitle(query) {
  const url = `https://en.wikipedia.org/w/api.php?action=query&list=search&srsearch=${encodeURIComponent(
    query
  )}&format=json&origin=*`;
  const res = await fetch(url);
  if (!res.ok) return null;
  const json = await res.json();
  return json?.query?.search?.[0]?.title || null;
}

async function getImageInfos(apiBase, titles) {
  if (!titles.length) return [];
  const url = `${apiBase}?action=query&titles=${encodeURIComponent(
    titles.join("|")
  )}&prop=imageinfo&iiprop=url|size|mime&iiurlwidth=900&format=json&origin=*`;
  const res = await fetch(url);
  if (!res.ok) return [];
  const json = await res.json();
  const pages = json?.query?.pages || {};
  return Object.values(pages)
    .map((p) => {
      const info = p.imageinfo && p.imageinfo[0];
      if (!info) return null;
      return {
        title: p.title,
        src: info.thumburl || info.url,
        width: info.thumbwidth || info.width || 0,
        height: info.thumbheight || info.height || 0,
        mime: info.mime || "",
      };
    })
    .filter((x) => x && x.src && x.mime.startsWith("image/") && x.mime !== "image/svg+xml");
}

const GOOGLE_IMAGE_SEARCH_ENABLED = import.meta.env.VITE_GOOGLE_IMAGE_SEARCH === 'true';
let googleImageSearchEnabled = true;

async function fetchGoogleImages(query, limit = 3) {
  const apiKey = import.meta.env.VITE_GOOGLE_API_KEY;
  const cx = import.meta.env.VITE_GOOGLE_CX;
  const enabled = GOOGLE_IMAGE_SEARCH_ENABLED && apiKey && cx && googleImageSearchEnabled;

  if (!enabled) return [];

  try {
    const url = `https://www.googleapis.com/customsearch/v1?key=${encodeURIComponent(apiKey)}&cx=${encodeURIComponent(cx)}&q=${encodeURIComponent(query)}&searchType=image&num=${limit}&imgSize=large&safe=active`;
    const res = await fetch(url);
    const text = await res.text();
    if (!res.ok) {
      let errBody = null;
      try { errBody = JSON.parse(text); } catch (e) { errBody = text; }
      console.warn('Google Custom Search error', res.status, errBody);
      if (res.status === 400 || res.status === 403) {
        const message = typeof errBody === 'object' ? errBody?.error?.message || '' : String(errBody);
        if (/custom search json api|permission_denied|access to Custom Search JSON API/i.test(message)) {
          googleImageSearchEnabled = false;
        }
      }
      return [];
    }
    const json = JSON.parse(text);
    const items = (json.items || []).filter(Boolean);

    // prefer jpg/jpeg/png links first, then take others
    const preferred = [];
    const fallback = [];
    for (const it of items) {
      const link = it.link || it.image?.thumbnailLink || it.image?.contextLink;
      if (!link) continue;
      const lower = link.toLowerCase();
      if (lower.endsWith('.jpg') || lower.endsWith('.jpeg') || lower.endsWith('.png')) preferred.push({ title: it.title || query, src: link });
      else fallback.push({ title: it.title || query, src: link });
    }
    const chosen = preferred.concat(fallback).slice(0, limit);
    return chosen;
  } catch (err) {
    console.warn('Google Custom Search request failed', err);
    return [];
  }
}

async function fetchIconicImages(displayName) {
  const googleResults = await fetchGoogleImages(displayName, 3);
  if (googleResults.length) return googleResults;

  let candidates = [];
  try {
    const title = await getPageTitle(displayName);
    if (title) {
      const listUrl = `https://en.wikipedia.org/w/api.php?action=query&titles=${encodeURIComponent(
        title
      )}&prop=images&imlimit=40&format=json&origin=*`;
      const res = await fetch(listUrl);
      if (res.ok) {
        const json = await res.json();
        const page = Object.values(json?.query?.pages || {})[0];
        const imgTitles = (page?.images || []).map((i) => i.title).filter((t) => !isBadImageTitle(t));
        if (imgTitles.length) {
          candidates = await getImageInfos("https://en.wikipedia.org/w/api.php", imgTitles.slice(0, 15));
        }
      }
    }
  } catch (e) {
    candidates = [];
  }

  if (candidates.length < 3) {
    try {
      const commonsUrl = `https://commons.wikimedia.org/w/api.php?action=query&list=search&srsearch=${encodeURIComponent(
        displayName
      )}&srnamespace=6&srlimit=15&format=json&origin=*`;
      const res = await fetch(commonsUrl);
      if (res.ok) {
        const json = await res.json();
        const titles = (json?.query?.search || []).map((s) => s.title).filter((t) => !isBadImageTitle(t));
        if (titles.length) {
          const infos = await getImageInfos("https://commons.wikimedia.org/w/api.php", titles);
          const seen = new Set(candidates.map((c) => c.title));
          infos.forEach((i) => {
            if (!seen.has(i.title)) candidates.push(i);
          });
        }
      }
    } catch (e) {
      // keep whatever candidates we already have
    }
  }

  return candidates
    .filter((c) => c.width >= 300)
    .sort((a, b) => b.width * b.height - a.width * a.height)
    .slice(0, 3)
    .map((c) => ({ title: c.title, src: c.src }));
}

/* ------------------------------ palette extraction ------------------------------ */
function rgbToHex(r, g, b) {
  const h = (n) => n.toString(16).padStart(2, "0");
  return `#${h(r)}${h(g)}${h(b)}`.toUpperCase();
}

function extractPaletteFromImage(img) {
  return new Promise((resolve) => {
    try {
      const size = 64;
      const canvas = document.createElement("canvas");
      canvas.width = size;
      canvas.height = size;
      const ctx = canvas.getContext("2d");
      ctx.drawImage(img, 0, 0, size, size);
      const data = ctx.getImageData(0, 0, size, size).data;

      const buckets = {};
      for (let i = 0; i < data.length; i += 4) {
        const a = data[i + 3];
        if (a < 128) continue;
        const r = data[i],
          g = data[i + 1],
          b = data[i + 2];
        const key = [Math.round(r / 24), Math.round(g / 24), Math.round(b / 24)].join(",");
        if (!buckets[key]) buckets[key] = { r: 0, g: 0, b: 0, count: 0 };
        buckets[key].r += r;
        buckets[key].g += g;
        buckets[key].b += b;
        buckets[key].count++;
      }

      const sorted = Object.values(buckets)
        .map((b) => ({ r: Math.round(b.r / b.count), g: Math.round(b.g / b.count), b: Math.round(b.b / b.count), count: b.count }))
        .sort((a, c) => c.count - a.count);

      const dist = (a, c) => Math.sqrt((a.r - c.r) ** 2 + (a.g - c.g) ** 2 + (a.b - c.b) ** 2);
      const chosen = [];
      for (const cand of sorted) {
        if (chosen.length >= 4) break;
        if (chosen.every((ch) => dist(ch, cand) > 34)) chosen.push(cand);
      }
      let i = 0;
      while (chosen.length < 4 && i < sorted.length) {
        if (!chosen.includes(sorted[i])) chosen.push(sorted[i]);
        i++;
      }
      resolve(chosen.slice(0, 4).map((c) => rgbToHex(c.r, c.g, c.b)));
    } catch (e) {
      resolve(null);
    }
  });
}

const NAMED_COLORS = [
  ["#F5F1E6", "Ivory"], ["#EFE1C6", "Bone"], ["#E8DCC8", "Sand"], ["#D6D2C4", "Stone"],
  ["#D9A441", "Ochre"], ["#E3B23C", "Marigold"], ["#C9A227", "Savanna Gold"], ["#C4A35A", "Straw"],
  ["#C97B4A", "Terracotta"], ["#D97757", "Sunset Clay"], ["#A63D2F", "Rust"], ["#A94438", "Brick"],
  ["#E4572E", "Ember"], ["#8B5E3C", "Umber"], ["#9C7A50", "Camel"], ["#6E4226", "Coffee"],
  ["#5C4033", "Espresso"], ["#2B2118", "Espresso Dark"], ["#1A1A1A", "Onyx"], ["#4A4A4A", "Charcoal"],
  ["#3A3F5C", "Dusk Indigo"], ["#2E4057", "Slate Blue"], ["#274472", "Deep Ocean"], ["#4B3F72", "Twilight"],
  ["#5B7C99", "Mist Blue"], ["#6E7F80", "Fog"], ["#8FA6A3", "Sea Foam"], ["#1B3A2B", "Forest Green"],
  ["#3E5641", "Pine"], ["#5C6B47", "Acacia Green"], ["#7A8B5C", "Sage"], ["#B7C9A8", "Sage Mist"],
  ["#7C3F58", "Plum"], ["#D8CBB8", "Linen"], ["#B98C56", "Adobe"],
];

function nearestColorName(hex) {
  const r = parseInt(hex.slice(1, 3), 16);
  const g = parseInt(hex.slice(3, 5), 16);
  const b = parseInt(hex.slice(5, 7), 16);
  let best = NAMED_COLORS[0],
    bestDist = Infinity;
  for (const [h, name] of NAMED_COLORS) {
    const cr = parseInt(h.slice(1, 3), 16);
    const cg = parseInt(h.slice(3, 5), 16);
    const cb = parseInt(h.slice(5, 7), 16);
    const d = (r - cr) ** 2 + (g - cg) ** 2 + (b - cb) ** 2;
    if (d < bestDist) {
      bestDist = d;
      best = [h, name];
    }
  }
  return best[1];
}

function cleanTitle(title) {
  return (title || "")
    .replace(/^File:/, "")
    .replace(/\.[a-zA-Z]+$/, "")
    .replace(/_/g, " ");
}

/* ---------------------------- packing list logic ---------------------------- */
function parseActivities(list) {
  return list.map((a) => a.toLowerCase());
}

function buildPackingList(weather, days, activities, isSafariLike) {
  const has = (words) => activities.some((a) => words.some((w) => a.includes(w)));
  const isSafari = isSafariLike || has(["safari", "game drive", "wildlife"]);
  const isHiking = has(["hik", "walk", "trek", "mountain", "altitude"]);
  const isSwim = has(["swim", "beach", "pool", "ocean", "water"]);
  const isPhoto = has(["photo", "camera"]);
  const isUrban = has(["city", "urban", "museum", "culture"]);
  const isWinter = has(["ski", "snow", "winter", "alpine"]);
  const isTropical = has(["tropical", "jungle", "humid"]);

  const cap = (n, max) => Math.min(n, max);
  const tops = cap(days, 7);
  const bottoms = cap(Math.ceil(days / 2) + 1, 6);
  const socks = cap(days + 1, 10);
  const underwear = cap(days + 1, 10);

  // Climate classification based on weather
  const isArctic = weather.low < 0;
  const isCold = weather.low < 12;
  const isMild = weather.high >= 12 && weather.high < 20;
  const isWarm = weather.high >= 20 && weather.high < 26;
  const isHot = weather.high >= 26;
  const isFreezing = weather.low < -5;
  const isSweltering = weather.high > 32;
  const tempSwing = weather.high - weather.low;
  const isHumid = weather.rain > 35 && isHot;

  const categories = [];

  // CLOTHING & LAYERS
  const clothing = [];

  if (isWinter || isFreezing) {
    clothing.push(
      { name: "Thermal base layers (top & bottom)", qty: `${Math.ceil(tops * 0.5)}` },
      { name: "Heavy wool or down coat", qty: "1" },
      { name: "Thick insulated pants", qty: `${bottoms}` },
      { name: "Merino wool socks (pairs)", qty: `${Math.ceil(socks * 1.5)}` },
      { name: "Warm hat (covers ears)", qty: "1" },
      { name: "Winter gloves or mittens", qty: "2 pairs" },
      { name: "Neck scarf or balaclava", qty: "1" }
    );
  } else if (isArctic) {
    clothing.push(
      { name: "Thermal base layers (top & bottom)", qty: `${Math.ceil(tops * 0.6)}` },
      { name: "Insulated parka or down jacket", qty: "1" },
      { name: "Warm trousers", qty: `${bottoms}` },
      { name: "Wool or synthetic socks (pairs)", qty: `${Math.ceil(socks * 1.2)}` },
      { name: "Warm hat", qty: "1" },
      { name: "Gloves or mittens", qty: "1 pair" },
      { name: "Neck warmer", qty: "1" }
    );
  } else if (isCold) {
    clothing.push(
      { name: "Long-sleeve shirts", qty: `${Math.ceil(tops * 0.6)}` },
      { name: "Short-sleeve shirts", qty: `${Math.floor(tops * 0.4) || 1}` },
      { name: "Warm fleece or cardigan", qty: "1-2" },
      { name: "Jeans or warm trousers", qty: `${bottoms}` },
      { name: "Wool socks (pairs)", qty: `${Math.ceil(socks * 1.1)}` },
      { name: "Sleepwear (warm)", qty: "2" },
      { name: "Underwear", qty: `${underwear}` }
    );
  } else if (isHumid) {
    clothing.push(
      { name: "Lightweight moisture-wicking shirts (short-sleeve)", qty: `${Math.ceil(tops * 0.8)}` },
      { name: "Lightweight moisture-wicking shirts (long-sleeve)", qty: `${Math.floor(tops * 0.2) || 1}` },
      { name: "Quick-dry shorts or lightweight pants", qty: `${bottoms}` },
      { name: "Lightweight undergarments (quick-dry)", qty: `${underwear}` },
      { name: "Thin, breathable socks (pairs)", qty: `${socks}` },
      { name: "Sleepwear (lightweight)", qty: "2" },
      { name: "Lightweight rain shirt (UV-blocking)", qty: "1" }
    );
  } else if (isHot && !isHumid) {
    clothing.push(
      { name: "Short-sleeve shirts / t-shirts", qty: `${Math.ceil(tops * 0.7)}` },
      { name: "Long-sleeve sun shirts (lightweight, UV-blocking)", qty: `${Math.floor(tops * 0.3) || 1}` },
      { name: "Lightweight shorts or breathable pants", qty: `${bottoms}` },
      { name: "Lightweight undergarments", qty: `${underwear}` },
      { name: "Breathable socks (pairs)", qty: `${socks}` },
      { name: "Sleepwear (very lightweight)", qty: "1-2" }
    );
  } else if (isMild) {
    clothing.push(
      { name: "Long-sleeve shirts", qty: `${Math.ceil(tops * 0.5)}` },
      { name: "Short-sleeve shirts", qty: `${Math.floor(tops * 0.5) || 1}` },
      { name: "Light sweater or cardigan", qty: "1" },
      { name: "Trousers or jeans", qty: `${bottoms}` },
      { name: "Socks (pairs)", qty: `${socks}` },
      { name: "Sleepwear (medium weight)", qty: "2" },
      { name: "Underwear", qty: `${underwear}` }
    );
  } else {
    clothing.push(
      { name: "Short-sleeve shirts", qty: `${Math.ceil(tops * 0.6)}` },
      { name: "Long-sleeve shirts", qty: `${Math.floor(tops * 0.4) || 1}` },
      { name: "Trousers / lightweight pants", qty: `${bottoms}` },
      { name: "Underwear", qty: `${underwear}` },
      { name: "Socks (pairs)", qty: `${socks}` },
      { name: "Sleepwear", qty: "2" }
    );
  }

  if (tempSwing > 15 && !isWinter && !isArctic) {
    clothing.push({ name: "Lightweight layering piece (fleece or cardigan)", qty: "1" });
  }

  if (isSafari) {
    clothing.push({
      name: "Neutral-toned clothing (khaki/olive/tan) — avoid white, black & blue",
      qty: "most items",
    });
  }
  if (isUrban) {
    clothing.push({ name: "Smart-casual outfit or light jacket", qty: "1" });
  }
  categories.push({ title: "Clothing & Layers", items: clothing });

  // FOOTWEAR
  const footwear = [];
  if (isWinter || isFreezing) {
    footwear.push(
      { name: "Insulated winter boots", qty: "1 pair" },
      { name: "Warm socks for boots", qty: "3 pairs" }
    );
  } else if (isCold) {
    footwear.push(
      { name: "Closed walking shoes or boots", qty: "1 pair" },
      { name: "Warm socks", qty: "2-3 pairs" }
    );
  } else if (isHumid || isHot) {
    footwear.push(
      { name: "Breathable walking shoes or mesh sneakers", qty: "1 pair" },
      { name: "Thin socks or no-show socks", qty: `${socks}` }
    );
  } else {
    footwear.push(
      { name: "Comfortable walking shoes", qty: "1 pair" },
      { name: "Socks", qty: `${socks}` }
    );
  }

  if (isHiking) footwear.push({ name: "Sturdy hiking boots (broken in)", qty: "1 pair" });
  if (isSwim) footwear.push({ name: "Water shoes or sandals", qty: "1 pair" });
  if (isUrban) footwear.push({ name: "Casual shoes or loafers", qty: "1 pair" });
  categories.push({ title: "Footwear", items: footwear });

  // SUN & WEATHER PROTECTION
  const protection = [];
  if (weather.uv >= 7) {
    protection.push(
      { name: "Sunscreen SPF 50+ (high UV formula)", qty: "2 bottles" },
      { name: "Wide-brim hat or cap", qty: "1" },
      { name: "Sunglasses (UV-400 protective)", qty: "1" },
      { name: "SPF lip balm", qty: "1" }
    );
  } else if (weather.uv >= 5) {
    protection.push(
      { name: "Sunscreen SPF 50", qty: "1 bottle" },
      { name: "Hat or sun visor", qty: "1" },
      { name: "Sunglasses", qty: "1" },
      { name: "SPF lip balm", qty: "1" }
    );
  }

  if (weather.rain > 55) {
    protection.push(
      { name: "Waterproof rain jacket", qty: "1" },
      { name: "Rain cover for bag", qty: "1" },
      { name: "Waterproof bag for electronics", qty: "1" }
    );
  } else if (weather.rain > 35) {
    protection.push(
      { name: "Packable or lightweight rain jacket", qty: "1" },
      { name: "Waterproof bag for essentials", qty: "1" }
    );
  } else if (weather.rain > 15) {
    protection.push({ name: "Compact travel umbrella", qty: "1" });
  }

  if (isTropical || isHumid) {
    protection.push({ name: "Quick-dry lightweight shirt", qty: "1" });
  }

  if (protection.length) categories.push({ title: "Sun & Weather Protection", items: protection });

  // ACTIVITY GEAR
  const gear = [];
  if (isSafari) {
    gear.push(
      { name: "Binoculars", qty: "1 pair" },
      { name: "Insect repellent (DEET 20%+)", qty: "1 bottle" },
      { name: "Anti-malarial medication", qty: "as prescribed" },
      { name: "Headlamp or flashlight", qty: "1" },
      { name: "Dust-proof bag for electronics", qty: "1" }
    );
  }
  if (isHiking) {
    gear.push(
      { name: "Hydration pack or water bottle (2L)", qty: "1" },
      { name: "Energy bars or trail snacks", qty: "several" },
      { name: "Hiking map or GPS device", qty: "1" },
      { name: "First aid kit (blister treatment)", qty: "1" },
      { name: "Moisture-wicking backpack (20-30L)", qty: "1" }
    );
  }
  if (isPhoto) {
    gear.push(
      { name: "Camera body & lens(es)", qty: "1" },
      { name: "Camera charger & backup battery", qty: "1" },
      { name: "Extra memory cards", qty: "3-4" },
      { name: "Lens cleaning kit", qty: "1" },
      { name: "Lightweight tripod or gorilla pod", qty: "1" }
    );
  }
  if (isSwim) {
    gear.push(
      { name: "Swimsuit(s)", qty: "2" },
      { name: "Quick-dry towel", qty: "1" },
      { name: "Rash guard or swim shirt (sun protection)", qty: "1" },
      { name: "Waterproof bag for valuables", qty: "1" }
    );
  }
  if (isFreezing || isWinter) {
    gear.push(
      { name: "Hand warmers (disposable)", qty: "several packets" },
      { name: "Moisturizer for dry skin", qty: "1" },
      { name: "Lip balm", qty: "1" }
    );
  }
  if (isHumid || isTropical) {
    gear.push(
      { name: "Moisture-control sheets or powder", qty: "1" },
      { name: "Anti-fungal foot powder", qty: "1" }
    );
  }
  if (gear.length) categories.push({ title: "Activity & Climate Gear", items: gear });

  // TOILETRIES & HEALTH
  const toiletries = [
    { name: "Prescription medications", qty: "full supply" },
    { name: "Pain relievers (ibuprofen/paracetamol)", qty: "1 pack" },
    { name: "Antidiarrheal medication", qty: "1 pack" },
    { name: "Antihistamine (allergies)", qty: "1 pack" },
    { name: "Basic first aid kit", qty: "1" },
  ];
  if (isCold) toiletries.push({ name: "Moisturizer (for dry skin)", qty: "1 small" });
  if (isHumid) toiletries.push({ name: "Anti-chafe balm", qty: "1" });
  if (weather.uv >= 6) toiletries.push({ name: "Aloe vera gel (for sunburn)", qty: "1 small" });
  categories.push({ title: "Toiletries & Health", items: toiletries });

  // DOCUMENTS & ESSENTIALS
  categories.push({
    title: "Documents & Essentials",
    items: [
      { name: "Passport (valid 6+ months)", qty: "1" },
      { name: "Visa or entry approval printout", qty: "1" },
      { name: "Travel insurance documents", qty: "1 copy" },
      { name: "Vaccination certificates (if required)", qty: "1 copy" },
      { name: "Hotel/accommodation confirmations", qty: "1 copy" },
      { name: "Emergency contact list", qty: "1 copy" },
      { name: "Credit/debit cards & some cash", qty: "mixed" },
      { name: "Plug adapter(s)", qty: "1-2" },
    ],
  });

  return categories;
}

const NEUTRAL_PALETTE = ["#C9A227", "#B5622B", "#5C6B47", "#3A3F5C"];

/* --------------------------------- UI bits --------------------------------- */
function Swatch({ hex, copied, onCopy }) {
  return (
    <button
      onClick={() => onCopy(hex)}
      className="swatch-card"
      style={{ backgroundColor: hex, color: "#1a1a1a" }}
    >
      <span className="swatch-label">{nearestColorName(hex)}</span>
      <span className="swatch-hex">{hex}</span>
      <span className="swatch-action">
        {copied === hex ? (
          <>
            <Check size={9} /> Copied
          </>
        ) : (
          <>
            <Copy size={9} /> Copy
          </>
        )}
      </span>
    </button>
  );
}

export default function PackingPalette() {
  // Calculate default dates: today to 5 days from now
  const getDefaultDates = () => {
    const today = new Date();
    today.setHours(0, 0, 0, 0);
    const start = today.toISOString().split('T')[0];
    const end = new Date(today.getTime() + 5 * 86400000).toISOString().split('T')[0];
    return { start, end };
  };

  const { start: defaultStart, end: defaultEnd } = getDefaultDates();

  const [locationInput, setLocationInput] = useState("");
  const [selectedLocation, setSelectedLocation] = useState(null);
  const [suggestions, setSuggestions] = useState([]);
  const [locationTouched, setLocationTouched] = useState(false);
  const suppressNextFetch = useRef(true);

  const [startDate, setStartDate] = useState(defaultStart);
  const [endDate, setEndDate] = useState(defaultEnd);
  const [activityInput, setActivityInput] = useState("");
  const [activities, setActivities] = useState([]);

  const [submitted, setSubmitted] = useState(null);

  const [weather, setWeather] = useState(null);
  const [weatherStatus, setWeatherStatus] = useState("idle");

  const [images, setImages] = useState([]);
  const [imagesStatus, setImagesStatus] = useState("idle");
  const [selectedPaletteIndex, setSelectedPaletteIndex] = useState(0);

  const [checked, setChecked] = useState({});
  const [copiedHex, setCopiedHex] = useState(null);

  const currentImage = images[selectedPaletteIndex] || null;

  const goToImage = (direction) => {
    if (!images.length) return;
    setSelectedPaletteIndex((prev) => (prev + direction + images.length) % images.length);
  };

  // autocomplete
  useEffect(() => {
    if (suppressNextFetch.current) {
      suppressNextFetch.current = false;
      return;
    }
    if (!locationTouched || locationInput.trim().length < 2) {
      setSuggestions([]);
      return;
    }
    const handle = setTimeout(async () => {
      try {
        const res = await fetch(
          `https://geocoding-api.open-meteo.com/v1/search?name=${encodeURIComponent(
            locationInput
          )}&count=6&language=en&format=json`
        );
        const json = await res.json();
        setSuggestions(json.results || []);
      } catch {
        setSuggestions([]);
      }
    }, 300);
    return () => clearTimeout(handle);
  }, [locationInput, locationTouched]);

  const pickSuggestion = (r) => {
    setSelectedLocation({ name: r.name, country: r.country, latitude: r.latitude, longitude: r.longitude });
    setLocationInput(`${r.name}, ${r.country}`);
    setSuggestions([]);
    setLocationTouched(false);
  };

  // fetch weather whenever a trip is submitted
  useEffect(() => {
    if (!submitted) return;
    let cancelled = false;
    setWeatherStatus("loading");
    fetchRealWeather(submitted.lat, submitted.lon, submitted.startDate, submitted.endDate).then((w) => {
      if (cancelled) return;
      setWeather(w);
      setWeatherStatus("ready");
    });
    return () => {
      cancelled = true;
    };
  }, [submitted]);

  // fetch iconic images + derive palettes whenever a trip is submitted
  useEffect(() => {
    if (!submitted) return;
    let cancelled = false;
    setImages([]);
    setImagesStatus("loading");
    setSelectedPaletteIndex(0);
    fetchIconicImages(submitted.location).then((list) => {
      if (cancelled) return;
      if (!list.length) {
        setImagesStatus("empty");
        return;
      }
      setImages(list.map((x) => ({ ...x, palette: null, status: "loading" })));
      setImagesStatus("ready");
      list.forEach((item, idx) => {
        const img = new Image();
        img.crossOrigin = "anonymous";
        img.onload = () => {
          extractPaletteFromImage(img).then((hexes) => {
            if (cancelled) return;
            setImages((prev) =>
              prev.map((p, i) => (i === idx ? { ...p, palette: hexes, status: hexes ? "ready" : "error" } : p))
            );
          });
        };
        img.onerror = () => {
          if (cancelled) return;
          setImages((prev) => prev.map((p, i) => (i === idx ? { ...p, status: "error" } : p)));
        };
        img.src = item.src;
      });
    });
    return () => {
      cancelled = true;
    };
  }, [submitted?.location]);

  const days = useMemo(() => {
    if (!submitted) return 0;
    return daysBetween(submitted.startDate, submitted.endDate);
  }, [submitted]);
  const nights = Math.max(days - 1, 0);

  const activePalette =
    images[selectedPaletteIndex]?.palette && images[selectedPaletteIndex].palette.length === 4
      ? images[selectedPaletteIndex].palette
      : NEUTRAL_PALETTE;

  const condition = useMemo(() => {
    if (!weather) return "";
    if (weather.rain > 55) return "Rainy, pack for wet weather";
    if (weather.rain > 35) return "Showers likely";
    if (weather.rain > 15) return "Mostly sunny, slight rain chance";
    return "Clear & dry";
  }, [weather]);

  const isSafariLike = submitted ? /(south africa|safari|kruger|savanna|savannah|bushveld|game reserve|serengeti|maasai|masai mara)/i.test(
    submitted.location
  ) : false;

  const packingCategories = useMemo(() => {
    if (!weather) return [];
    return buildPackingList(weather, days, parseActivities(submitted.activities), isSafariLike);
  }, [weather, days, submitted, isSafariLike]);

  const handleAddActivity = () => {
    const val = activityInput.trim();
    if (val && !activities.includes(val)) {
      setActivities([...activities, val]);
      setActivityInput("");
    }
  };

  const handleGenerate = () => {
    if (!selectedLocation) return;
    setChecked({});
    setSubmitted({
      location: `${selectedLocation.name}, ${selectedLocation.country}`,
      lat: selectedLocation.latitude,
      lon: selectedLocation.longitude,
      startDate,
      endDate,
      activities,
    });
  };

  const toggleCheck = (id) => setChecked((c) => ({ ...c, [id]: !c[id] }));

  const handleCopy = (hex) => {
    if (navigator.clipboard) navigator.clipboard.writeText(hex);
    setCopiedHex(hex);
    setTimeout(() => setCopiedHex(null), 1500);
  };

  const canGenerate = !!selectedLocation;

  return (
    <div className="app-shell" style={{ backgroundColor: "#181B20", color: "#EDE7DA" }}>
      <style>{`
        @import url('https://fonts.googleapis.com/css2?family=Space+Grotesk:wght@500;700&family=IBM+Plex+Mono:wght@400;500;600&family=Inter:wght@400;500;600&display=swap');
        .pp-display { font-family: 'Space Grotesk', sans-serif; }
        .pp-mono { font-family: 'IBM Plex Mono', monospace; }
        .pp-body { font-family: 'Inter', sans-serif; }
      `}</style>

      <div className="pp-body page-shell">
        <header className="hero-header">
          <Plane size={28} style={{ color: "#C9A227" }} />
          <div>
            <h1 className="pp-display hero-title">PACKING PALETTE</h1>
            <p className="pp-mono hero-subtitle">know what to pack, before you go</p>
          </div>
        </header>

        {/* input card */}
        <div className="input-card">
          <div className="form-grid">
            <label className="field-shell">
              <span className="pp-mono field-label">
                <MapPin size={12} /> Destination
              </span>
              <input
                className="field-input"
                value={locationInput}
                onChange={(e) => {
                  setLocationInput(e.target.value);
                  setLocationTouched(true);
                  setSelectedLocation(null);
                }}
                placeholder="Start typing a city..."
              />
              {suggestions.length > 0 && (
                <ul className="suggestion-list" role="listbox">
                  {suggestions.map((s, i) => (
                    <li key={`${s.latitude}-${s.longitude}-${i}`}>
                      <button
                        type="button"
                        role="option"
                        aria-label={`Select ${s.name}, ${s.country}`}
                        onMouseDown={() => pickSuggestion(s)}
                        className="suggestion-item"
                      >
                        {s.name}, {s.country}
                        {s.admin1 ? ` · ${s.admin1}` : ""}
                      </button>
                    </li>
                  ))}
                </ul>
              )}
              {!selectedLocation && locationTouched && (
                <span className="pp-mono field-hint">
                  Pick a city from the list
                </span>
              )}
            </label>

            <label className="field-shell">
              <span className="pp-mono field-label">
                <Plus size={12} /> Activities (optional)
              </span>
              <div className="activity-row">
                <input
                  className="field-input"
                  value={activityInput}
                  onChange={(e) => setActivityInput(e.target.value)}
                  onKeyDown={(e) => e.key === "Enter" && (e.preventDefault(), handleAddActivity())}
                  placeholder="e.g. Hiking"
                />
                <button onClick={handleAddActivity} className="action-button">
                  Add
                </button>
              </div>
            </label>

            <label className="field-shell">
              <span className="pp-mono field-label">
                <CalendarDays size={12} /> Start date
              </span>
              <input type="date" className="field-input" value={startDate} onChange={(e) => setStartDate(e.target.value)} />
            </label>
            <label className="field-shell">
              <span className="pp-mono field-label">
                <CalendarDays size={12} /> End date
              </span>
              <input type="date" className="field-input" value={endDate} onChange={(e) => setEndDate(e.target.value)} />
            </label>
          </div>

          {activities.length > 0 && (
            <div className="activity-chips">
              {activities.map((a) => (
                <span key={a} className="activity-chip">
                  {a}
                  <button
                    type="button"
                    className="chip-close"
                    aria-label={`Remove activity ${a}`}
                    onClick={() => setActivities(activities.filter((x) => x !== a))}
                  >
                    <X size={12} />
                  </button>
                </span>
              ))}
            </div>
          )}

          <button
            onClick={handleGenerate}
            disabled={!canGenerate}
            className="pp-display generate-button disabled:opacity-40"
          >
            Pack for this trip
          </button>
        </div>

        {submitted && (
        <div className="pp-mono trip-meta">
          <span>{submitted.location}</span>
          <span>·</span>
          <span>{days} days / {nights} nights</span>
          {weather && (
            <>
              <span>·</span>
              <span>{condition}</span>
            </>
          )}
        </div>
        )}

        {/* weather */}
        <section className="info-section">
          <div className="section-heading">
            <div>
              <p className="section-kicker">Trip read</p>
              <h2 className="section-title">Weather Summary</h2>
            </div>
          </div>
          {weatherStatus === "loading" && (
            <div className="pp-mono status-pill">
              <Loader2 size={14} className="animate-spin" /> Fetching weather data...
            </div>
          )}
          {weatherStatus === "ready" && weather && (
            <>
              <div className="weather-grid">
                <div className="weather-card">
                  <Thermometer size={16} style={{ color: "#B5622B" }} />
                  <p className="pp-mono weather-value">{weather.high}°C</p>
                  <p className="weather-label">avg daytime high</p>
                </div>
                <div className="weather-card">
                  <Thermometer size={16} style={{ color: "#3A3F5C" }} />
                  <p className="pp-mono weather-value">{weather.low}°C</p>
                  <p className="weather-label">avg morning low</p>
                </div>
                <div className="weather-card">
                  <CloudRain size={16} style={{ color: "#5C6B47" }} />
                  <p className="pp-mono weather-value">{weather.rain}%</p>
                  <p className="weather-label">rain chance</p>
                </div>
                <div className="weather-card">
                  <Sun size={16} style={{ color: "#C9A227" }} />
                  <p className="pp-mono weather-value">{weather.uv}</p>
                  <p className="weather-label">UV index (est.)</p>
                </div>
              </div>
              <p className="pp-mono weather-footnote">
                <Wind size={11} /> Source: {weather.source}
                {weather.high - weather.low > 12 ? " · large day-to-night swing — layers matter here" : ""}
              </p>
            </>
          )}
        </section>

        {/* destination palette */}
        <section className="info-section">
          <div className="section-heading">
            <div>
              <p className="section-kicker">Destination moodboard</p>
              <h2 className="section-title">Destination Palette</h2>
            </div>
            {images.length > 0 && (
              <div className="carousel-nav" role="navigation" aria-label="Image carousel">
                <button type="button" className="carousel-button" onClick={() => goToImage(-1)} aria-label="Previous image">
                  <ChevronLeft size={16} />
                </button>
                <button type="button" className="carousel-button" onClick={() => goToImage(1)} aria-label="Next image">
                  <ChevronRight size={16} />
                </button>
              </div>
            )}
          </div>
          {imagesStatus === "loading" && (
            <div className="pp-mono status-pill">
              <Loader2 size={14} className="animate-spin" /> Finding iconic photos...
            </div>
          )}
          {imagesStatus === "empty" && (
            <p className="pp-mono empty-state">
              No iconic photos found for this destination — packing list is using a neutral default palette.
            </p>
          )}
          {imagesStatus === "ready" && (
            <div className="carousel-card">
              <div className="carousel-media">
                {currentImage ? (
                  <>
                    <img src={currentImage.src} alt={cleanTitle(currentImage.title)} />
                    <div className="carousel-caption">
                      <p className="pp-mono">{cleanTitle(currentImage.title)}</p>
                    </div>
                  </>
                ) : (
                  <div className="empty-state">No image selected</div>
                )}
              </div>
              <div className="carousel-sidebar">
                <div className="thumb-strip">
                  {images.map((img, i) => (
                    <button
                      key={img.title + i}
                      type="button"
                      className={`thumb-pill ${i === selectedPaletteIndex ? "active" : ""}`}
                      onClick={() => img.palette && setSelectedPaletteIndex(i)}
                    >
                      <img src={img.src} alt={cleanTitle(img.title)} />
                      <span>{cleanTitle(img.title)}</span>
                    </button>
                  ))}
                </div>
                <div className="palette-panel">
                  <div className="palette-panel-header">
                    <p className="section-kicker">Selected palette</p>
                    <span className="pp-mono palette-meta">{currentImage?.palette?.length ? `${currentImage.palette.length} swatches` : "Awaiting colors"}</span>
                  </div>
                  {currentImage?.status === "loading" && (
                    <div className="pp-mono status-pill compact">
                      <Loader2 size={12} className="animate-spin" /> Extracting colors...
                    </div>
                  )}
                  {currentImage?.status === "error" && (
                    <div className="pp-mono empty-state compact">Couldn't read this image</div>
                  )}
                  {currentImage?.palette && (
                    <div className="swatch-grid">
                      {currentImage.palette.map((hex) => (
                        <Swatch key={hex} hex={hex} copied={copiedHex} onCopy={handleCopy} />
                      ))}
                    </div>
                  )}
                </div>
              </div>
            </div>
          )}
        </section>

        {/* packing list */}
        <section className="info-section">
          <div className="section-heading">
            <div>
              <p className="section-kicker">Travel checklist</p>
              <h2 className="section-title">Packing List</h2>
            </div>
          </div>
          {weatherStatus === "loading" ? (
            <p className="pp-mono empty-state">Waiting on weather data...</p>
          ) : (
            <div className="packing-list">
              {packingCategories.map((cat, ci) => {
                const accent = activePalette[ci % activePalette.length];
                return (
                  <div key={cat.title} className="packing-category" style={{ borderColor: accent }}>
                    <h3 className="pp-mono packing-category-title">{cat.title}</h3>
                    <ul className="packing-items">
                      {cat.items.map((item, ii) => {
                        const id = `${ci}-${ii}`;
                        const isChecked = !!checked[id];
                        return (
                          <li key={id} className={`packing-item ${isChecked ? "checked" : ""}`} onClick={() => toggleCheck(id)}>
                            <span className="packing-left">
                              <span
                                className={`packing-checkbox ${isChecked ? "checked" : ""}`}
                                style={{ borderColor: accent, backgroundColor: isChecked ? accent : "transparent" }}
                              >
                                {isChecked && <Check size={11} color="#181B20" />}
                              </span>
                              <span className="packing-name">{item.name}</span>
                            </span>
                            <span className="pp-mono packing-qty">{item.qty}</span>
                          </li>
                        );
                      })}
                    </ul>
                  </div>
                );
              })}
            </div>
          )}
        </section>

        <footer className="pp-mono footer-note">
          <Luggage size={12} /> Weather is a live/historical average, not a guaranteed forecast — check again closer to departure.
        </footer>
      </div>
    </div>
  );
}