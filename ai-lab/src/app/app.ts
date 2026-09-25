import { AfterViewInit, Component, computed, signal } from '@angular/core';
import { AgentChat } from './components/agent-chat/agent-chat';
import { MissionMaker } from './components/mission-maker/mission-maker';
import { ScreenshotTour, TourStarter } from './components/screenshot-tour/screenshot-tour';

interface LabStage {
  id: string;
  title: string;
  blurb: string;
  live: boolean;
  kind: 'chat' | 'mission' | 'tour';
  description: string;
  starters: string[];
}

// One app per corner of the catalog: a puzzle, a kids' game, a home tool and
// a study aid. The strip hides any that drop out of the tour (Streak Rings is
// hidden server-side), so a stale id here just loses its chip.
const TOUR_STARTERS: TourStarter[] = [
  { label: 'Tour Toehold: Sudoku Explained', appId: 6801322941 },
  { label: 'Tour Cosmic Cadets', appId: 6782706983 },
  { label: 'Tour Homefolio: Home Inventory', appId: 6806631158 },
  { label: 'Tour US Citizenship Questions Prep', appId: 6778971932 },
];

/** Share links: ?stage=tour&app=6801322941 opens straight into that tour.
 *  app must be all digits; anything else is dropped here rather than sent on
 *  to the API. Read once, at startup. */
function shareLink(): { stage: string | null; app: number | null } {
  try {
    const q = new URLSearchParams(location.search);
    const raw = q.get('app') ?? '';
    const app = /^\d{1,16}$/.test(raw) && Number.isSafeInteger(Number(raw)) ? Number(raw) : null;
    return { stage: q.get('stage'), app };
  } catch {
    return { stage: null, app: null };
  }
}

@Component({
  selector: 'app-root',
  imports: [AgentChat, MissionMaker, ScreenshotTour],
  templateUrl: './app.html',
  styleUrl: './app.scss',
})
export class App implements AfterViewInit {
  readonly stages: LabStage[] = [
    {
      id: 'guess',
      title: 'Guess My App',
      blurb: 'Twenty questions against my live App Store catalog',
      live: true,
      kind: 'chat',
      description:
        "I've secretly dealt one of my published iOS apps. Ask yes/no questions to narrow it down, then guess the name. The host answers from live App Store data with the app's name redacted out of it — it genuinely does not know the answer, so it cannot let it slip. Only the server can confirm your guess.",
      // Each starter must split the live catalog. "Does it cost anything?"
      // (all free) and "Was it released this year?" (all 2026, and the host
      // is never told the date) got one answer for all 15 apps and wasted a
      // counted question. Recheck against the lookup when the catalog grows.
      starters: [
        'Is it a game?',
        'Is it for kids?',
        'Is it about money?',
        'Is it an education app?',
      ],
    },
    {
      id: 'reviews',
      title: 'App Review Analyst',
      blurb: 'The habit-app market my Streak Rings competes in, from my own lakehouse',
      live: true,
      kind: 'chat',
      description:
        "John's apps are too new to have reviews worth analyzing, so this agent studies the market his Apple Watch habit tracker Streak Rings competes in. It reads the daily gold snapshot of Review Radar, his Databricks lakehouse of App Store reviews for five habit apps, plus their live written reviews. The tools do the math and the agent cites its sources; watch every tool call stream in live.",
      // Each starter maps to data that exists today: version drops come from
      // the gold snapshot's rating_by_version, complaints from the live feed,
      // the Finch gap from the overview's written-review vs store averages.
      // The fourth keeps the honest answer about John's own apps one tap away.
      starters: [
        "Which habit app's rating fell the most after an update?",
        'What do habit-tracker users complain about that Streak Rings could win on?',
        'Why does Finch rate higher on the App Store than in its written reviews?',
        "How are John's own apps doing on the App Store?",
      ],
    },
    {
      id: 'concierge',
      title: 'Portfolio Concierge',
      blurb: 'Ask anything about my apps — grounded answers, right app picks',
      live: true,
      kind: 'chat',
      description:
        "A friendly guide to John's portfolio: it knows the published apps (live from the App Store), the web apps, and the tech behind them — and can recommend the right app for you.",
      starters: [
        'Which of your apps would suit my 6-year-old?',
        'What tech stack do you build with?',
        'Tell me about Cosmic Cadets',
        'What web apps has John built?',
      ],
    },
    {
      id: 'missions',
      title: 'Math Mission Maker',
      blurb: 'Playable missions from schema-validated JSON',
      live: true,
      kind: 'mission',
      description: '',
      starters: [],
    },
    {
      id: 'tour',
      title: 'Screenshot Tour',
      blurb: 'Gemini reads my real App Store screenshots and pins what each screen does',
      live: true,
      kind: 'tour',
      description:
        "Pick one of my apps and Gemini looks at its real App Store screenshots, then pins what each screen does. Every pin has to quote my store description word for word — my server checks each quote against the listing and each box against the image before anything is drawn, and the footer says how many pins made it. Tap a pin to see the sentence it's grounded in.",
      starters: TOUR_STARTERS.map((s) => s.label),
    },
  ];

  readonly tourStarters = TOUR_STARTERS;

  private readonly link = shareLink();
  readonly active = signal(
    this.stages.some((s) => s.live && s.id === this.link.stage) ? this.link.stage! : 'guess'
  );
  readonly activeStage = computed(() => this.stages.find((s) => s.id === this.active()));

  /** The tour's open app: seeded from a share link, then kept so coming back
   *  to the tab reopens it (the component is rebuilt on every visit). */
  readonly tourApp = signal<number | null>(this.link.stage === 'tour' ? this.link.app : null);

  // On a phone the stage cards scroll sideways, and a share link opens the
  // last one, off the end of the row. (Not afterNextRender: it added 2.8 kB.)
  ngAfterViewInit(): void {
    document.querySelector('.stage.active')?.scrollIntoView({ block: 'nearest', inline: 'nearest' });
  }

  open(stageId: string): void {
    this.active.set(stageId);
    this.syncUrl();
  }

  onTourApp(appId: number): void {
    this.tourApp.set(appId);
    this.syncUrl();
  }

  /** Keep the address bar a working share link for the open tour, and drop
   *  it on other tabs so a copied URL never reopens a tab you left. Other
   *  query params (utm_*) are left alone. */
  private syncUrl(): void {
    try {
      const url = new URL(location.href);
      url.searchParams.delete('stage');
      url.searchParams.delete('app');
      if (this.active() === 'tour') {
        url.searchParams.set('stage', 'tour');
        const app = this.tourApp();
        if (app !== null) url.searchParams.set('app', String(app));
      }
      if (url.href !== location.href) history.replaceState(history.state, '', url);
    } catch { /* no History API (sandboxed frame): the link just doesn't follow */ }
  }
}
