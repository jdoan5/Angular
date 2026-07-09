import { Component, computed, input, output } from '@angular/core';

interface Key {
  letter: string;
  state: 'idle' | 'hit' | 'miss';
}

const ROWS = ['ABCDEFGHI', 'JKLMNOPQR', 'STUVWXYZ'];

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
      [...row].map((letter) => ({
        letter,
        state: !guessed.has(letter) ? 'idle' : word.includes(letter) ? 'hit' : 'miss',
      })),
    );
  });
}
