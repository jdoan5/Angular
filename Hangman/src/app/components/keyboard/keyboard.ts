import { Component, computed, input, output } from '@angular/core';

type KeyState = 'idle' | 'hit' | 'miss';

interface Key {
  letter: string;
  state: KeyState;
  /** Spoken name: says whether a guessed letter was in the word, not just its colour. */
  label: string;
}

const ROWS = ['ABCDEFGHI', 'JKLMNOPQR', 'STUVWXYZ'];

const LABEL: Record<KeyState, (letter: string) => string> = {
  idle: (l) => `Guess letter ${l}`,
  hit: (l) => `${l}, in the word`,
  miss: (l) => `${l}, not in the word`,
};

/** Alphabetical on-screen keyboard; keys colour themselves hit/miss once guessed. */
@Component({
  selector: 'app-keyboard',
  templateUrl: './keyboard.html',
  styleUrl: './keyboard.scss',
})
export class Keyboard {
  readonly guessed = input<ReadonlySet<string>>(new Set());
  readonly word = input('');
  readonly locked = input(false);

  readonly pick = output<string>();

  protected readonly rows = computed<Key[][]>(() => {
    const guessed = this.guessed();
    const word = this.word();
    return ROWS.map((row) =>
      [...row].map((letter) => {
        const state: KeyState = !guessed.has(letter) ? 'idle' : word.includes(letter) ? 'hit' : 'miss';
        return { letter, state, label: LABEL[state](letter) };
      }),
    );
  });
}
