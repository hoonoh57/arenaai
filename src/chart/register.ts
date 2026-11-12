import {registerChartAddon} from '../../shared/chart';

/** 기본 애드온. 지워도 캔들 코어는 동작한다. */
registerChartAddon({id: 'indicators'});
registerChartAddon({id: 'drawings'});
registerChartAddon({id: 'patterns'});
registerChartAddon({id: 'panes'});
