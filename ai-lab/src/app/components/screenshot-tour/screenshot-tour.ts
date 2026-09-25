import { Component, DestroyRef, ElementRef, OnInit, computed, inject, input, output, signal } from '@angular/core';

/** A starter chip: the label the stage shows and the app it opens. */
export interface TourStarter {
  label: string;
  appId: number;
}

/** One icon in the strip (GET /api/tour). shots are the 600x1300 URLs in
 *  App Store order, so frames can appear before any tour is looked up. */
interface TourApp {
  appId: number;
  name: string;
  artwork: string;
  version: string;
  tourKey: string;
  shots: string[];
  hasSnapshot: boolean;
}

interface Callout {
  shot: number;
  box_2d: number[]; // [ymin, xmin, ymax, xmax] on 0-1000
  label: string;
  quote: string;
}

interface Tour {
  appId: number;
  name: string;
  version: string;
  tourKey: string;
  shots: { url: string }[];
  callouts: Callout[];
  dropped: { count: number; reasons: Record<string, number> };
}

interface Receipt {
  model: string;
  ms: number;
  promptTokenCount: number;
  imageTokens: number;
  candidatesTokenCount: number;
  thoughtsTokenCount: number;
  attempts: number;
  mediaResolution: string;
}

type Source = 'snapshot' | 'cache' | 'live';

interface TraceStep {
  tool: string;
  args: Record<string, unknown>;
  summary: string;
  running?: boolean;
}

type TourEvent =
  | { type: 'tool-start'; tool: string; args: Record<string, unknown> }
  | { type: 'tool-end'; tool: string; summary: string }
  | { type: 'tour'; tour: Tour; receipt: Receipt; source: Source }
  | { type: 'done'; model: string }
  | { type: 'error'; error: string };

/** A callout as drawn: numbered across the whole tour, geometry in %. */
interface Pin {
  n: number;
  shot: number;
  label: string;
  quote: string;
  x: number;
  y: number;
  top: number;
  left: number;
  height: number;
  width: number;
}

/** What was on screen before 'Watch it live', restored if the live run fails
 *  so a rate-limited visitor keeps the reviewed tour instead of a blank. */
interface Shown {
  tour: Tour;
  receipt: Receipt | null;
  source: Source | null;
}

type Phase = 'strip' | 'loading' | 'tour' | 'error';

const SOURCE_LABEL: Record<Source, string> = {
  snapshot: 'reviewed snapshot',
  cache: 'cached',
  live: 'live',
};

// A missing function is served index.html by vercel.json's catch-all
// rewrite (200, text/html), so "not JSON" means the API isn't deployed here.
const UNAVAILABLE = 'The screenshot tour is not available right now.';

// The strip survives a stage switch (the component is destroyed with the
// tab), so coming back is instant. A stale entry is caught by the 409 path.
let stripCache: TourApp[] | null = null;

/** Body as JSON, or null for a platform error page / truncated body. */
async function readJson(res: Response): Promise<any> {
  const body = await res.text();
  try {
    return JSON.parse(body);
  } catch {
    return null;
  }
}

function isApp(a: any): a is TourApp {
  return (
    Number.isSafeInteger(a?.appId) &&
    typeof a.name === 'string' &&
    typeof a.tourKey === 'string' &&
    Array.isArray(a.shots) &&
    a.shots.every((s: unknown) => typeof s === 'string' && s.startsWith('https://'))
  );
}

/** The strip draws icons at 56px; artworkUrl512 is 14.7 KB per icon against
 *  3 KB at 128x128 (measured on Toehold), and there are 14 of them. mzstatic
 *  serves any size from the last path segment; anything else is left alone. */
export function iconUrl(artwork: string): string {
  return artwork.replace(/\/\d+x\d+bb\.(jpg|png|webp)$/, '/128x128bb.$1');
}

/** Callouts the server kept, numbered in callout order across all shots. The
 *  server already validated every box; this only refuses to draw NaN pins if
 *  a malformed payload ever slips through. */
export function toPins(tour: Tour | null): Pin[] {
  if (!tour || !Array.isArray(tour.callouts)) return [];
  const pins: Pin[] = [];
  for (const c of tour.callouts) {
    const b = c?.box_2d;
    if (!Number.isInteger(c?.shot) || c.shot < 0 || c.shot >= tour.shots.length) continue;
    if (!Array.isArray(b) || b.length !== 4 || !b.every((v) => Number.isFinite(v) && v >= 0 && v <= 1000)) continue;
    const [ymin, xmin, ymax, xmax] = b;
    if (ymin >= ymax || xmin >= xmax) continue;
    pins.push({
      n: pins.length + 1,
      shot: c.shot,
      label: String(c.label ?? ''),
      quote: String(c.quote ?? ''),
      x: (xmin + xmax) / 20,
      y: (ymin + ymax) / 20,
      top: ymin / 10,
      left: xmin / 10,
      height: (ymax - ymin) / 10,
      width: (xmax - xmin) / 10,
    });
  }
  return pins;
}

/** Parse an NDJSON byte stream into events, tolerating a line split across
 *  chunks (same reader as AgentService). */
async function* readEvents(body: ReadableStream<Uint8Array>): AsyncGenerator<TourEvent> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      let nl: number;
      while ((nl = buffer.indexOf('\n')) >= 0) {
        const line = buffer.slice(0, nl).trim();
        buffer = buffer.slice(nl + 1);
        if (!line) continue;
        let event: TourEvent | null = null;
        try {
          event = JSON.parse(line) as TourEvent;
        } catch { /* corrupt line — skip; a missing 'tour' reports the drop */ }
        if (event) yield event;
      }
    }
    const rest = (buffer + decoder.decode()).trim();
    if (rest) {
      try {
        yield JSON.parse(rest) as TourEvent;
      } catch { /* truncated tail */ }
    }
  } finally {
    reader.releaseLock();
  }
}

/** Stage 5: Gemini vision over my real App Store screenshots. The server
 *  checks every callout (quote verbatim in the listing, box on the image)
 *  before this component draws a single pin. Reviewed snapshots load
 *  instantly; 'Watch it live' streams a fresh run's tool trace. */
@Component({
  selector: 'app-screenshot-tour',
  imports: [],
  templateUrl: './screenshot-tour.html',
  styleUrl: './screenshot-tour.scss',
  host: { '(document:keydown.escape)': 'closePin()' },
})
export class ScreenshotTour implements OnInit {
  readonly heading = input('');
  readonly description = input('');
  readonly starters = input<TourStarter[]>([]);
  /** From a share link or a previous visit to this tab; opened only if the
   *  strip lists it (hidden apps never are). */
  readonly initialAppId = input<number | null>(null);
  readonly appChange = output<number>();

  private readonly host: ElementRef<HTMLElement> = inject(ElementRef);

  readonly stripStatus = signal<'loading' | 'ready' | 'error'>('loading');
  readonly stripError = signal('');
  readonly apps = signal<TourApp[]>([]);
  readonly selectedId = signal<number | null>(null);
  readonly phase = signal<Phase>('strip');
  readonly errorMsg = signal('');
  readonly tour = signal<Tour | null>(null);
  readonly receipt = signal<Receipt | null>(null);
  readonly source = signal<Source | null>(null);
  readonly trace = signal<TraceStep[]>([]);
  readonly streaming = signal(false);
  readonly model = signal('');
  readonly activePin = signal<number | null>(null);

  readonly selected = computed(() => this.apps().find((a) => a.appId === this.selectedId()) ?? null);
  readonly visibleStarters = computed(() => {
    const ids = new Set(this.apps().map((a) => a.appId));
    return this.starters().filter((s) => ids.has(s.appId));
  });
  /** The tour's own shots once drawn (its boxes were measured on exactly
   *  those), else the strip's so the frames show up immediately. */
  readonly shots = computed(() => this.tour()?.shots.map((s) => s.url) ?? this.selected()?.shots ?? []);
  readonly pins = computed(() => toPins(this.tour()));
  readonly pinsByShot = computed(() => this.shots().map((_, i) => this.pins().filter((p) => p.shot === i)));
  readonly active = computed(() => this.pins().find((p) => p.n === this.activePin()) ?? null);

  /** 'grounded X/Y callouts · Z dropped (reasons)', Y = kept + dropped. */
  readonly groundingLine = computed(() => {
    const t = this.tour();
    if (!t) return '';
    const kept = this.pins().length;
    const dropped = Number(t.dropped?.count) || 0;
    const reasons = Object.entries(t.dropped?.reasons ?? {})
      .filter(([, n]) => n > 0)
      .map(([why, n]) => `${n} ${why.replace(/_/g, ' ')}`)
      .join(', ');
    return `grounded ${kept}/${kept + dropped} callouts · ${dropped} dropped${reasons ? ` (${reasons})` : ''}`;
  });

  readonly sourceLine = computed(() => {
    const src = this.source();
    if (!src) return '';
    const r = this.receipt();
    const parts = [SOURCE_LABEL[src] ?? src];
    if (src === 'live' && r) {
      if (Number.isFinite(r.ms)) parts.push(`${(r.ms / 1000).toFixed(1)} s`);
      if (Number.isFinite(r.promptTokenCount)) parts.push(`${r.promptTokenCount.toLocaleString('en-US')} prompt tokens`);
      if (r.attempts > 1) parts.push(`${r.attempts} attempts`);
    }
    return parts.join(' · ');
  });

  private ac: AbortController | null = null;
  private stripAc = new AbortController();

  constructor() {
    inject(DestroyRef).onDestroy(() => {
      // Leaving the tab closes the stream, and the server stops the model call.
      this.ac?.abort();
      this.stripAc.abort();
    });
  }

  ngOnInit(): void {
    if (stripCache) {
      this.apps.set(stripCache);
      this.stripStatus.set('ready');
      this.openInitial();
    } else {
      void this.loadStrip().then((ok) => ok && this.openInitial());
    }
  }

  private openInitial(): void {
    const id = this.initialAppId();
    if (id !== null) this.select(id);
  }

  /** GET /api/tour. On a refetch (409) a failure keeps the icons already shown. */
  async loadStrip(): Promise<boolean> {
    if (!this.apps().length) this.stripStatus.set('loading');
    try {
      const res = await fetch('/api/tour', { signal: this.stripAc.signal });
      const data = await readJson(res);
      if (!res.ok) throw new Error(data?.error ?? `HTTP ${res.status}`);
      if (!Array.isArray(data?.apps)) throw new Error(UNAVAILABLE);
      const apps = (data.apps as unknown[]).filter(isApp);
      if (!apps.length) throw new Error(UNAVAILABLE);
      stripCache = apps;
      this.apps.set(apps);
      this.stripStatus.set('ready');
      return true;
    } catch (err) {
      if (this.stripAc.signal.aborted) return false;
      console.warn('tour strip failed:', err);
      if (!this.apps().length) {
        this.stripError.set(err instanceof TypeError ? 'Could not reach the server — check your connection.' : message(err));
        this.stripStatus.set('error');
      }
      return false;
    }
  }

  select(appId: number): void {
    const app = this.apps().find((a) => a.appId === appId);
    if (!app) return;
    // Re-tapping the open app is a no-op, except to retry after an error.
    if (appId === this.selectedId() && this.phase() !== 'error') return;
    this.selectedId.set(appId);
    this.appChange.emit(appId);
    void this.lookup(app);
  }

  retry(): void {
    const app = this.selected();
    if (app) void this.lookup(app);
  }

  /** GET /api/tour?app=&key= — snapshot or cache, never a model call. */
  private async lookup(app: TourApp, refetched = false): Promise<void> {
    const ac = this.restart();
    try {
      const url = `/api/tour?app=${app.appId}&key=${encodeURIComponent(app.tourKey)}`;
      const res = await fetch(url, { signal: ac.signal });
      const data = await readJson(res);
      if (ac.signal.aborted) return;
      if (res.ok && data?.tour) {
        this.show({ tour: data.tour, receipt: data.receipt ?? null, source: data.source ?? 'snapshot' });
        return;
      }
      if (res.status === 404 && data?.needsLive) {
        // No reviewed tour for this listing yet: generate one right away.
        await this.stream(app, false, ac, null);
        return;
      }
      if (res.status === 409 && !refetched) {
        // The listing moved on (new version or screenshots) since the strip
        // loaded. Refresh it once. The strip is CDN-cached (10 min, plus an
        // hour stale), so it can still carry the old key; the 409 names the
        // current one, and a tour brings its own shots.
        await this.loadStrip();
        if (ac.signal.aborted) return;
        const fresh = this.apps().find((a) => a.appId === app.appId) ?? app;
        const key = fresh.tourKey !== app.tourKey ? fresh.tourKey : String(data?.tourKey ?? '');
        if (key && key !== app.tourKey) {
          await this.lookup({ ...fresh, tourKey: key }, true);
          return;
        }
      }
      if (res.status === 409) throw new Error('This app’s App Store listing just changed — try again in a minute.');
      if (res.ok || !data) throw new Error(UNAVAILABLE);
      throw new Error(data.error ?? `HTTP ${res.status}`);
    } catch (err) {
      if (!ac.signal.aborted) this.fail(err, null);
    }
  }

  /** 'Watch it live': a fresh generation even when a snapshot exists. */
  watchLive(): void {
    const app = this.selected();
    if (!app || this.streaming()) return;
    const t = this.tour();
    const prev: Shown | null = t ? { tour: t, receipt: this.receipt(), source: this.source() } : null;
    void this.stream(app, true, this.restart(), prev);
  }

  /** POST /api/tour, read as NDJSON: the trace fills in as each tool runs. */
  private async stream(app: TourApp, fresh: boolean, ac: AbortController, prev: Shown | null): Promise<void> {
    this.streaming.set(true);
    let drew = false;
    try {
      const res = await fetch('/api/tour', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(fresh ? { appId: app.appId, fresh: true } : { appId: app.appId }),
        signal: ac.signal,
      });
      if (!res.ok) {
        // Guard rejections (429, 503, 400) are JSON; platform errors aren't.
        const data = await readJson(res);
        throw new Error(data?.error ?? `HTTP ${res.status}`);
      }
      if (!res.body || !(res.headers.get('content-type') ?? '').includes('ndjson')) throw new Error(UNAVAILABLE);
      for await (const event of readEvents(res.body)) {
        if (ac.signal.aborted) return;
        switch (event.type) {
          case 'tool-start':
            this.trace.update((t) => [...t, { tool: event.tool, args: event.args ?? {}, summary: '', running: true }]);
            break;
          case 'tool-end':
            this.trace.update((t) => {
              const copy = [...t];
              for (let i = copy.length - 1; i >= 0; i--) {
                if (copy[i].running && copy[i].tool === event.tool) {
                  copy[i] = { ...copy[i], summary: event.summary, running: false };
                  break;
                }
              }
              return copy;
            });
            break;
          case 'tour':
            this.show({ tour: event.tour, receipt: event.receipt ?? null, source: event.source ?? 'live' });
            drew = true;
            break;
          case 'done':
            if (event.model) this.model.set(event.model);
            break;
          case 'error':
            throw new Error(event.error);
        }
      }
      if (!drew && !ac.signal.aborted) throw new Error('The connection dropped mid-tour — try again.');
    } catch (err) {
      if (!ac.signal.aborted && !drew) this.fail(err, prev);
    } finally {
      if (this.ac === ac) {
        this.streaming.set(false);
        // A step still spinning after the stream ended never finished.
        this.trace.update((t) => t.map((s) => (s.running ? { ...s, running: false, summary: 'stopped' } : s)));
      }
    }
  }

  /** Abort whatever the last app was doing and clear the stage for the next. */
  private restart(): AbortController {
    this.ac?.abort();
    const ac = (this.ac = new AbortController());
    this.streaming.set(false);
    this.tour.set(null);
    this.receipt.set(null);
    this.source.set(null);
    this.trace.set([]);
    this.errorMsg.set('');
    this.activePin.set(null);
    this.phase.set('loading');
    return ac;
  }

  private show(s: Shown): void {
    this.tour.set(s.tour);
    this.receipt.set(s.receipt);
    this.source.set(s.source);
    if (s.receipt?.model) this.model.set(s.receipt.model);
    this.phase.set('tour');
  }

  private fail(err: unknown, prev: Shown | null): void {
    console.warn('screenshot tour failed:', err);
    const msg = err instanceof TypeError ? 'Could not reach the server — check your connection.' : message(err);
    if (prev) {
      this.show(prev);
      this.errorMsg.set(`${msg} Showing the ${SOURCE_LABEL[prev.source ?? 'snapshot']} tour instead.`);
    } else {
      this.errorMsg.set(msg);
      this.phase.set('error');
    }
  }

  openPin(n: number): void {
    this.activePin.set(n);
    // After render: bring the pin into view (its scroll-margin keeps it above
    // the mobile bottom sheet) and move focus into the panel for Escape/Tab.
    setTimeout(() => {
      this.reveal(n);
      this.host.nativeElement.querySelector<HTMLElement>('.detail .close')?.focus({ preventScroll: true });
    });
  }

  closePin(): void {
    const n = this.activePin();
    if (n === null) return;
    this.activePin.set(null);
    // Back to the pin it came from, so keyboard users keep their place.
    this.pinEl(n)?.focus({ preventScroll: true });
  }

  /** Prev/next wrap around rather than disable, so focus never lands on a
   *  button that just switched off. */
  stepPin(delta: number): void {
    const n = this.activePin();
    const count = this.pins().length;
    if (n === null || !count) return;
    const next = ((n - 1 + delta + count) % count) + 1;
    this.activePin.set(next);
    setTimeout(() => this.reveal(next));
  }

  private reveal(n: number): void {
    this.pinEl(n)?.scrollIntoView({ block: 'nearest', inline: 'center', behavior: 'smooth' });
  }

  private pinEl(n: number): HTMLElement | null {
    return this.host.nativeElement.querySelector<HTMLElement>(`.pin[data-pin="${n}"]`);
  }

  icon(artwork: string): string {
    return iconUrl(artwork);
  }

  argsPreview(args: Record<string, unknown>): string {
    const entries = Object.entries(args ?? {});
    if (!entries.length) return '';
    return entries.map(([k, v]) => `${k}: ${typeof v === 'object' ? JSON.stringify(v) : v}`).join(', ');
  }
}

function message(err: unknown): string {
  return err instanceof Error && err.message ? err.message : 'Something went wrong — try again.';
}
