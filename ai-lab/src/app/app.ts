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
      starters: [
        'Is it a game?',
        'Is it for kids?',
        'Was it released this year?',
        'Does it cost anything?',
      ],
    },
    {
      id: 'reviews',
      title: 'App Review Analyst',
      blurb: 'Live App Store reviews, analyzed by an agent with tools',
      live: true,
      kind: 'chat',
      description:
        "An agent with live App Store tools: it lists John's published apps, pulls their public reviews and ratings, then analyzes sentiment, themes, and trends — and can draft developer replies. Watch its tool calls stream in live.",
      starters: [
        'How are my apps rated overall?',
        'Summarize the latest reviews of Cosmic Cadets',
        'What do reviewers complain about most, across all my apps?',
        'Draft a friendly reply to the most critical recent review',
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
