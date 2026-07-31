import { Component, signal } from '@angular/core';
import { ReviewAnalyst } from './components/review-analyst/review-analyst';

interface LabStage {
  id: string;
  title: string;
  blurb: string;
  live: boolean;
}

@Component({
  selector: 'app-root',
  imports: [ReviewAnalyst],
  templateUrl: './app.html',
  styleUrl: './app.scss',
})
export class App {
  readonly stages: LabStage[] = [
    {
      id: 'reviews',
      title: 'App Review Analyst',
      blurb: 'Live App Store reviews, analyzed by an agent with tools',
      live: true,
    },
    {
      id: 'concierge',
      title: 'Portfolio Concierge',
      blurb: 'Ask anything about my apps — grounded answers, right app picks',
      live: false,
    },
    {
      id: 'missions',
      title: 'Math Mission Maker',
      blurb: 'Adaptive math word problems, Cosmic Cadets style',
      live: false,
    },
  ];

  readonly active = signal('reviews');
}
