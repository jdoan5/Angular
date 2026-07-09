import { Component, input } from '@angular/core';

/**
 * Ink-drawn hangman figure. `stage` (0–6) reveals one body part per miss;
 * `lost` swaps the face to X-eyes on defeat.
 */
@Component({
  selector: 'app-gallows',
  templateUrl: './gallows.html',
  styleUrl: './gallows.scss',
})
export class Gallows {
  readonly stage = input(0);
  readonly lost = input(false);
}
