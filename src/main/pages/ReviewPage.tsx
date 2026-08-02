import { useLocation } from 'react-router-dom';
import { CalendarPage } from './CalendarPage';
import { ReportPage } from './ReportPage';

export function ReviewPage() {
  const { pathname } = useLocation();
  const isReport = pathname === '/report';

  return (
    <div>
      <div className="review-tabs">
        <div className="seg">
          <a href="#/calendar" className={`seg-btn${!isReport ? ' active' : ''}`}>日历</a>
          <a href="#/report" className={`seg-btn${isReport ? ' active' : ''}`}>报告</a>
        </div>
      </div>
      {isReport ? <ReportPage /> : <CalendarPage />}
    </div>
  );
}
