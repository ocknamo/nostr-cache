import { Routes } from '@angular/router';
import { TimelineComponent } from './components/timeline/timeline.component';

export const routes: Routes = [
  { path: '', component: TimelineComponent },
  { path: '**', redirectTo: '' },
];
