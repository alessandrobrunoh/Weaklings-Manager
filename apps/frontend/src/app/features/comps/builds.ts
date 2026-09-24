import { ChangeDetectionStrategy, Component } from '@angular/core';

import { Comps } from './comps';

/** Build workspace route, kept separate from compositions while sharing its data/table logic. */
@Component({
  selector: 'app-builds',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [Comps],
  template: '<app-comps page="builds" />',
})
export class Builds {}
