import { ChangeDetectionStrategy, Component } from '@angular/core';

import { Comps } from './comps';

/** Composition workspace route, kept separate from builds while sharing the table implementation. */
@Component({
  selector: 'app-compositions',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [Comps],
  template: '<app-comps page="comps" />',
})
export class Compositions {}
