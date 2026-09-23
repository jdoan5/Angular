import { Component, computed, signal } from '@angular/core';
import { AgentChat } from './components/agent-chat/agent-chat';
import { MissionMaker } from './components/mission-maker/mission-maker';

interface LabStage {
  id: string;
  title: string;
  blurb: string;
  live: boolean;
  kind: 'chat' | 'mission';
  description: string;
  starters: string[];
}

@Component({
  selector: 'app-root',
  imports: [AgentChat, MissionMaker],
  templateUrl: './app.html',
  styleUrl: './app.scss',
})
export class App {
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
      blurb: 'Live App Store ratings and releases, read by an agent with tools',
      live: true,
      kind: 'chat',
      description:
        "An agent with live App Store tools: it lists John's published apps and reads their ratings, versions, update dates and release notes, then checks the public review feed. The apps are new and written reviews are still rare — when there are none, it says so instead of inventing sentiment. Watch its tool calls stream in live.",
      // Answerable from data that exists: the 15 apps have a handful of
      // ratings and almost no written reviews, so three of the old four
      // starters ended in "no reviews found".
      starters: [
        "Which of John's apps have ratings so far?",
        'What changed in the latest Cosmic Cadets update?',
        "Which of John's apps were updated most recently?",
        'Check the review feed for Learn English: Pronunciation',
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
  ];

  readonly active = signal('guess');
  readonly activeStage = computed(() => this.stages.find((s) => s.id === this.active()));
}
