import { Injectable, signal } from '@angular/core';
import { Snapshot } from '../models/snapshot';

@Injectable({ providedIn: 'root' })
export class SnapshotService {
  readonly snapshot = signal<Snapshot | null>(null);
  readonly error = signal<string | null>(null);

  constructor() {
    fetch('gold_snapshot.json')
      .then((res) => {
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        return res.json();
      })
      .then((data: Snapshot) => this.snapshot.set(data))
      .catch((err) => this.error.set(String(err)));
  }
}
