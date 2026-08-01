import { Component, computed, signal } from '@angular/core';

interface MissionProblem {
  question: string;
  equation: string;
  choices: number[];
  answerIndex: number;
  hint: string;
}

interface Mission {
  title: string;
  intro: string;
  problems: MissionProblem[];
}

type Phase = 'setup' | 'loading' | 'play' | 'done';

/** Stage 3: schema-constrained generation. Gemini returns a JSON mission
 *  (responseSchema-validated server-side) and this component makes it
 *  playable — Cosmic Cadets style, gentle retries and all. */
@Component({
  selector: 'app-mission-maker',
  imports: [],
  templateUrl: './mission-maker.html',
  styleUrl: './mission-maker.scss',
})
export class MissionMaker {
  readonly skills = [
    { id: 'counting', label: 'Counting' },
    { id: 'addition', label: 'Adding' },
    { id: 'subtraction', label: 'Subtracting' },
    { id: 'missing', label: 'Missing Number' },
    { id: 'comparison', label: 'More or Less' },
    { id: 'multiplication', label: 'Groups ×2 ×5 ×10' },
  ];
  readonly tiers = [1, 2, 3, 4, 5];

  readonly skill = signal('addition');
  readonly tier = signal(2);
  readonly phase = signal<Phase>('setup');
  readonly errorMsg = signal('');
  readonly mission = signal<Mission | null>(null);
  readonly missionJson = signal('');
  readonly model = signal('');

  // Play state
  readonly index = signal(0);
  readonly triedWrong = signal<Set<number>>(new Set());
  readonly solvedFirstTry = signal(0);
  readonly showHint = signal(false);
  readonly celebrating = signal(false);

  readonly current = computed(() => this.mission()?.problems[this.index()] ?? null);
  readonly stars = computed(() => this.solvedFirstTry());

  async generate(): Promise<void> {
    if (this.phase() === 'loading') return;
    this.phase.set('loading');
    this.errorMsg.set('');
    try {
      const res = await fetch('/api/mission', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ skill: this.skill(), tier: this.tier() }),
      });
      const body = await res.text();
      let data: { mission?: Mission; model?: string; error?: string } = {};
      try {
        data = JSON.parse(body);
      } catch { /* non-JSON platform error */ }
      if (!res.ok || !data.mission) {
        throw new Error(data.error ?? `HTTP ${res.status}`);
      }
      this.mission.set(data.mission);
      this.missionJson.set(JSON.stringify(data.mission, null, 2));
      this.model.set(data.model ?? '');
      this.index.set(0);
      this.solvedFirstTry.set(0);
      this.resetProblemState();
      this.phase.set('play');
    } catch (err) {
      this.errorMsg.set(err instanceof Error ? err.message : String(err));
      this.phase.set('setup');
    }
  }

  choose(i: number): void {
    const p = this.current();
    if (!p || this.celebrating() || this.triedWrong().has(i)) return;
    if (i === p.answerIndex) {
      if (this.triedWrong().size === 0) this.solvedFirstTry.update((n) => n + 1);
      this.celebrating.set(true);
      setTimeout(() => this.advance(), 900);
    } else {
      this.triedWrong.update((s) => new Set(s).add(i));
      this.showHint.set(true);
    }
  }

  private advance(): void {
    const m = this.mission();
    if (!m) return;
    if (this.index() + 1 < m.problems.length) {
      this.index.update((i) => i + 1);
      this.resetProblemState();
    } else {
      this.phase.set('done');
    }
  }

  private resetProblemState(): void {
    this.triedWrong.set(new Set());
    this.showHint.set(false);
    this.celebrating.set(false);
  }

  replay(): void {
    this.index.set(0);
    this.solvedFirstTry.set(0);
    this.resetProblemState();
    this.phase.set('play');
  }

  newMission(): void {
    this.mission.set(null);
    this.phase.set('setup');
  }

  choiceState(i: number): 'idle' | 'correct' | 'wrong' {
    const p = this.current();
    if (!p) return 'idle';
    if (this.celebrating() && i === p.answerIndex) return 'correct';
    if (this.triedWrong().has(i)) return 'wrong';
    return 'idle';
  }
}
