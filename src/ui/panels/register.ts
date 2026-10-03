import { registerPanel } from './PanelHost';
import { LayersPanel } from './LayersPanel';
import { PropertiesPanel } from './PropertiesPanel';
import { DrawPanel, EditPanel, TextPanel, MeasurePanel } from './ToolPanels';
import { SearchPanel } from './SearchPanel';
import { ExportPanel } from './ExportPanel';
import { ProjectPanel, VersionsPanel, SettingsPanel, MorePanel } from './ProjectPanels';
import { GpsPanel, CalibrationPanel } from '../gps/GpsPanels';

registerPanel('layers', { title: 'Layer Manager', component: LayersPanel, tall: true });
registerPanel('props', { title: 'Properties', component: PropertiesPanel, tall: true });
registerPanel('draw', { title: 'Draw', component: DrawPanel });
registerPanel('edit', { title: 'Modify', component: EditPanel });
registerPanel('text', { title: 'Text', component: TextPanel });
registerPanel('measure', { title: 'Measure', component: MeasurePanel });
registerPanel('search', { title: 'Search', component: SearchPanel, tall: true });
registerPanel('export', { title: 'Export', component: ExportPanel });
registerPanel('project', { title: 'Project', component: ProjectPanel, tall: true });
registerPanel('versions', { title: 'Versions', component: VersionsPanel, tall: true });
registerPanel('settings', { title: 'Settings', component: SettingsPanel, tall: true });
registerPanel('more', { title: 'More', component: MorePanel });
registerPanel('gps', { title: 'GPS', component: GpsPanel, tall: true });
registerPanel('calib', { title: 'Calibration Wizard', component: CalibrationPanel, tall: true });

// ---- V2: FTTH, field, outputs, admin ----
import '../../ftth/tools';
import '../../ftth/overlay';
import '../ftth/integration';
import { FtthPanel } from '../ftth/FtthPanel';
import { SurveyPanel, NotesPanel, PhotosPanel, MaintenancePanel } from '../field/FieldPanels';
import { QrPanel, ComparePanel, ReportsPanel } from '../ftth/OutputPanels';
import { UsersPanel, SyncPanel } from './AdminPanels';

registerPanel('ftth', { title: 'FTTH Network', component: FtthPanel, tall: true });
registerPanel('survey', { title: 'Field Survey', component: SurveyPanel, tall: true });
registerPanel('notes', { title: 'Field Notes', component: NotesPanel, tall: true });
registerPanel('photos', { title: 'Photos & Media', component: PhotosPanel, tall: true });
registerPanel('maintenance', { title: 'Maintenance & Faults', component: MaintenancePanel, tall: true });
registerPanel('qr', { title: 'QR Codes', component: QrPanel, tall: true });
registerPanel('compare', { title: 'Design vs As-Built', component: ComparePanel, tall: true });
registerPanel('reports', { title: 'Reports & BOQ', component: ReportsPanel, tall: true });
registerPanel('users', { title: 'Users, Roles & Audit', component: UsersPanel, tall: true });
registerPanel('sync', { title: 'Cloud Sync', component: SyncPanel });

// dev-only handle on the live module instances (used by automated UI tests)
import * as __ftthStore from '../../ftth/store';
import * as __topology from '../../ftth/topology';
import * as __detect from '../../ftth/detect';
import * as __projects from '../../data/projects';
import * as __field from '../../field/fieldData';
import * as __gps from '../../gps/controller';
import * as __boq from '../../ftth/boq';
import * as __reports from '../../reports/reports';
if (import.meta.env.DEV) (window as any).__fl = { ftth: __ftthStore, topology: __topology, detect: __detect, projects: __projects, field: __field, gps: __gps, boq: __boq, reports: __reports };
