import React, { useState, useEffect, useRef, useMemo, useCallback } from 'react';
import { Link } from 'react-router-dom';
import UniversalNavbar from '../../components/layout/AdminNavbar';
import WorklistSearch from '../../components/admin/WorklistSearch';
import api from '../../services/api';
import { useAuth } from '../../hooks/useAuth';

const LabDashboard = React.memo(() => {
  const { currentUser } = useAuth();
  
  // 🔧 MEMOIZE THE USER TO PREVENT UNNECESSARY RE-RENDERS
  const stableUser = useMemo(() => currentUser, [currentUser?.id, currentUser?.role]);

  const [allStudies, setAllStudies] = useState([]);
  const [loading, setLoading] = useState(true);
  const [activeCategory, setActiveCategory] = useState('all');
  
  // 🔧 SIMPLIFIED: Single page mode state management (matching admin/doctor)
  const [recordsPerPage, setRecordsPerPage] = useState(500);
  const [totalRecords, setTotalRecords] = useState(0);
  
  // 🆕 NEW: Date filter state for backend integration (matching admin/doctor)
  const [dateFilter, setDateFilter] = useState('today'); // Default to 24 hours
  const [customDateFrom, setCustomDateFrom] = useState('');
  const [customDateTo, setCustomDateTo] = useState('');
  const [dateType, setDateType] = useState('UploadDate'); // StudyDate, UploadDate
  
  const [dashboardStats, setDashboardStats] = useState({
    totalStudies: 0,
    pendingUpload: 0,
    uploadedToday: 0,
    processingStudies: 0,
    completedStudies: 0,
    urgentStudies: 0
  });

  const [values, setValues] = useState({
    today: 0,
    pending: 0,
    inprogress: 0,
    completed: 0,
  });
  
  // 🔧 AUTO-REFRESH STATE
  const [lastRefresh, setLastRefresh] = useState(new Date());
  const [nextRefreshIn, setNextRefreshIn] = useState(300); // 5 minutes in seconds
  const intervalRef = useRef(null);
  const countdownRef = useRef(null);

  // 🆕 NEW: API endpoint mapping for tabs (EXACTLY like admin dashboard)
  const getEndpointForCategory = useCallback((category) => {
    switch (category) {
      case 'pending':
        return '/lab/studies/pending';
      case 'inprogress':
        return '/lab/studies/processing';  // Note: using 'processing' endpoint for 'inprogress' category
      case 'completed':
        return '/lab/studies/completed';
      case 'all':
      default:
        return '/lab/studies';
    }
  }, []);

  // 🔧 UPDATED: Fetch studies with dynamic endpoint (EXACTLY like admin dashboard)
  const fetchAllData = useCallback(async (searchParams = {}) => {
    try {
      setLoading(true);
      console.log(`🔄 LAB: Fetching ${activeCategory} studies with synchronized filters`);
      
      // 🆕 NEW: Use category-specific endpoint
      const endpoint = getEndpointForCategory(activeCategory);
      
      // Build common API parameters
      const apiParams = {
        limit: recordsPerPage,
        dateType: dateType,
        ...searchParams
      };

      // Add date filter parameters
      if (dateFilter === 'custom') {
        if (customDateFrom) apiParams.customDateFrom = customDateFrom;
        if (customDateTo) apiParams.customDateTo = customDateTo;
        apiParams.quickDatePreset = 'custom';
      } else if (dateFilter && dateFilter !== 'all') {
        apiParams.quickDatePreset = dateFilter;
      }
      
      // Remove undefined values
      Object.keys(apiParams).forEach(key => 
        apiParams[key] === undefined && delete apiParams[key]
      );

      console.log(`📤 LAB: API Parameters for ${activeCategory}:`, apiParams);
      console.log(`🎯 LAB: Using endpoint: ${endpoint}`);
      
      // 🔧 UPDATED: Make API calls to category-specific endpoints
      const [studiesResponse, valuesResponse] = await Promise.all([
        api.get(endpoint, { params: apiParams }),
        api.get('/lab/values', { params: apiParams })
      ]);
      
      // Process studies response
      if (studiesResponse.data.success) {
        setAllStudies(studiesResponse.data.data);
        setTotalRecords(studiesResponse.data.totalRecords);
        setLastRefresh(new Date());
        
        // Update dashboard stats from backend response
        if (studiesResponse.data.summary?.byCategory) {
          setDashboardStats({
            totalStudies: studiesResponse.data.summary.byCategory.all || studiesResponse.data.totalRecords,
            pendingUpload: studiesResponse.data.summary.byCategory.pending || 0,
            uploadedToday: studiesResponse.data.summary.uploadedToday || 0,
            processingStudies: studiesResponse.data.summary.byCategory.processing || studiesResponse.data.summary.byCategory.inprogress || 0,
            completedStudies: studiesResponse.data.summary.byCategory.completed || 0,
            urgentStudies: studiesResponse.data.summary.urgentStudies || 
                           studiesResponse.data.data.filter(s => ['EMERGENCY', 'STAT', 'URGENT'].includes(s.priority)).length
          });
        } else {
          // Fallback to client-side counting (less efficient)
          const studies = studiesResponse.data.data;
          const today = new Date().toDateString();
          
          setDashboardStats({
            totalStudies: studiesResponse.data.totalRecords,
            pendingUpload: studies.filter(s => s.workflowStatus === 'pending_upload' || s.currentCategory === 'pending').length,
            uploadedToday: studies.filter(s => {
              const uploadDate = s.uploadDateTime || s.createdAt;
              return uploadDate && new Date(uploadDate).toDateString() === today;
            }).length,
            processingStudies: studies.filter(s => ['processing', 'in_progress'].includes(s.workflowStatus) || s.currentCategory === 'inprogress').length,
            completedStudies: studies.filter(s => s.workflowStatus === 'completed' || s.currentCategory === 'completed').length,
            urgentStudies: studies.filter(s => ['EMERGENCY', 'STAT', 'URGENT'].includes(s.priority)).length
          });
        }
      }

      // Process values response
      if (valuesResponse.data && valuesResponse.data.success) {
        setValues({
          today: valuesResponse.data.total || 0,
          pending: valuesResponse.data.pending || 0,
          inprogress: valuesResponse.data.inprogress || 0,
          completed: valuesResponse.data.completed || 0,
        });
      }
      
      console.log(`✅ LAB: ${activeCategory} data fetched successfully`);
      
    } catch (error) {
      console.error(`❌ LAB: Error fetching ${activeCategory} data:`, error);
      setAllStudies([]);
      setTotalRecords(0);
      setValues({
        today: 0,
        pending: 0,
        inprogress: 0,
        completed: 0,
      });
    } finally {
      setLoading(false);
    }
  }, [activeCategory, recordsPerPage, dateFilter, customDateFrom, customDateTo, dateType, getEndpointForCategory]);

  // 🔧 SIMPLIFIED: Single useEffect for initial load and dependency changes
  useEffect(() => {
    console.log(`🔄 LAB: Data dependencies changed - fetching fresh data`);
    fetchAllData();
  }, [fetchAllData]);

  // 🔧 SIMPLIFIED: Single auto-refresh interval
  useEffect(() => {
    intervalRef.current = setInterval(() => {
      console.log('🔄 LAB: Auto-refreshing all data...');
      fetchAllData();
    }, 5 * 60 * 1000); // 5 minutes

    return () => {
      if (intervalRef.current) {
        clearInterval(intervalRef.current);
      }
    };
  }, [fetchAllData]);

  // 🆕 NEW: Date filter handlers (matching admin)
  const handleDateFilterChange = useCallback((newDateFilter) => {
    console.log(`📅 LAB: Changing date filter to ${newDateFilter}`);
    setDateFilter(newDateFilter);
    setNextRefreshIn(300); // Reset countdown
  }, []);

  const handleCustomDateChange = useCallback((from, to) => {
    console.log(`📅 LAB: Setting custom date range from ${from} to ${to}`);
    setCustomDateFrom(from);
    setCustomDateTo(to);
    if (from || to) {
      setDateFilter('custom');
    }
    setNextRefreshIn(300); // Reset countdown
  }, []);

  const handleDateTypeChange = useCallback((newDateType) => {
    console.log(`📅 LAB: Changing date type to ${newDateType}`);
    setDateType(newDateType);
    setNextRefreshIn(300); // Reset countdown
  }, []);

  // 🆕 NEW: Handle search with backend parameters (matching admin)
  const handleSearchWithBackend = useCallback((searchParams) => {
    console.log('🔍 LAB: Handling search with backend params:', searchParams);
    fetchAllData(searchParams);
  }, [fetchAllData]);

  // Handle category change (matching admin pattern)
  const handleCategoryChange = useCallback((category) => {
    console.log(`🏷️ LAB: Changing category from ${activeCategory} to ${category}`);
    
    // 🔧 FIXED: Only change if actually different
    if (activeCategory !== category) {
      setActiveCategory(category);
      setNextRefreshIn(300); // Reset countdown
    }
  }, [activeCategory]);

  // 🔧 SIMPLIFIED: Handle records per page change (no pagination, matching admin)
  const handleRecordsPerPageChange = useCallback((newRecordsPerPage) => {
    console.log(`📊 LAB: Changing records per page from ${recordsPerPage} to ${newRecordsPerPage}`);
    setRecordsPerPage(newRecordsPerPage);
    setNextRefreshIn(300); // Reset countdown
  }, [recordsPerPage]);

  // Handle assignment completion (refresh data)
  const handleAssignmentComplete = useCallback(() => {
    console.log('📋 LAB: Assignment completed, refreshing studies...');
    fetchAllData();
    setNextRefreshIn(300); // Reset countdown
  }, [fetchAllData]);

  // Handle manual refresh
  const handleManualRefresh = useCallback(() => {
    console.log('🔄 LAB: Manual refresh triggered');
    fetchAllData();
    setNextRefreshIn(300); // Reset countdown
  }, [fetchAllData]);

  // Handle worklist view
  const handleWorklistView = useCallback((view) => {
    console.log('LAB: Worklist view changed:', view);
    setNextRefreshIn(300); // Reset countdown
  }, []);

  // 🔧 FORMAT NEXT REFRESH TIME
  const formatRefreshTime = useMemo(() => {
    const minutes = Math.floor(nextRefreshIn / 60);
    const seconds = nextRefreshIn % 60;
    return `${minutes}:${seconds.toString().padStart(2, '0')}`;
  }, [nextRefreshIn]);

  // 🔧 FORMAT LAST REFRESH TIME
  const formatLastRefresh = useMemo(() => {
    return lastRefresh.toLocaleTimeString('en-US', {
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit'
    });
  }, [lastRefresh]);

  return (
    <div className="h-screen bg-gray-50 flex flex-col">
      <UniversalNavbar />

      <div className="min-w-full mx-auto p-1 sm:p-2 lg:p-0 flex-1 flex flex-col">
        {/* 🔧 CLEAN: Main Content - Now WorklistSearch handles all controls (matching admin) */}
        <div className="bg-white flex-1 min-h-0 rounded border border-gray-200 overflow-hidden flex flex-col">
          <div className="flex-1 flex flex-col min-h-0 p-0 sm:p-2 lg:px-1 lg:pb-0 pb-0">
            <WorklistSearch 
              allStudies={allStudies}
              loading={loading}
              totalRecords={totalRecords}
              userRole="lab_staff"
              onAssignmentComplete={handleAssignmentComplete}
              onView={handleWorklistView}
              activeCategory={activeCategory}
              onCategoryChange={handleCategoryChange}
              categoryStats={dashboardStats}
              recordsPerPage={recordsPerPage}
              onRecordsPerPageChange={handleRecordsPerPageChange}
              dateFilter={dateFilter}
              onDateFilterChange={handleDateFilterChange}
              customDateFrom={customDateFrom}
              customDateTo={customDateTo}
              onCustomDateChange={handleCustomDateChange}
              dateType={dateType}
              onDateTypeChange={handleDateTypeChange}
              onSearchWithBackend={handleSearchWithBackend}
              values={values}
              // 🆕 NEW: Pass additional props for integrated controls (NO websocket props for lab)
              connectionStatus="connected" // Static for lab dashboard
              onManualRefresh={handleManualRefresh}
            />
          </div>
        </div>

        {/* 🔧 CLEAN: Mobile Stats - Keep this for mobile view (matching admin) */}
        <div className="lg:hidden mt-1 sm:mt-2">
          <details className="bg-white rounded border border-gray-200 shadow-sm">
            <summary className="px-2 py-1.5 cursor-pointer text-xs font-medium text-gray-700 hover:bg-gray-50 select-none">
              <span className="flex items-center justify-between">
                <span>View Lab Statistics</span>
                <span className="text-blue-600">Auto-refresh: {formatRefreshTime}</span>
              </span>
            </summary>
            <div className="px-2 pb-2">
              {/* Auto-refresh info section */}
              <div className="mb-2 p-2 bg-blue-50 rounded text-xs">
                <div className="flex items-center justify-between">
                  <span className="text-blue-700 font-medium">Auto-refresh enabled</span>
                  <span className="text-blue-600">{formatRefreshTime}</span>
                </div>
                <div className="w-full bg-blue-200 rounded-full h-1 mt-1 overflow-hidden">
                  <div 
                    className="h-full bg-blue-500 transition-all duration-1000 ease-linear"
                    style={{ 
                      width: `${((300 - nextRefreshIn) / 300) * 100}%` 
                    }}
                  ></div>
                </div>
                <div className="text-xs text-blue-600 mt-1">
                  Last updated: {formatLastRefresh}
                </div>
              </div>

              {/* Stats Grid - Lab specific */}
              <div className="grid grid-cols-3 gap-1 sm:gap-2">
                <div className="text-center p-1.5 bg-yellow-50 rounded">
                  <div className="text-sm font-semibold text-yellow-600">
                    {dashboardStats.pendingUpload.toLocaleString()}
                  </div>
                  <div className="text-xs text-gray-500">Pending</div>
                </div>
                <div className="text-center p-1.5 bg-blue-50 rounded">
                  <div className="text-sm font-semibold text-blue-600">
                    {dashboardStats.uploadedToday.toLocaleString()}
                  </div>
                  <div className="text-xs text-gray-500">Today</div>
                </div>
                <div className="text-center p-1.5 bg-orange-50 rounded">
                  <div className="text-sm font-semibold text-orange-600">
                    {dashboardStats.processingStudies.toLocaleString()}
                  </div>
                  <div className="text-xs text-gray-500">Processing</div>
                </div>
                <div className="text-center p-1.5 bg-green-50 rounded">
                  <div className="text-sm font-semibold text-green-600">
                    {dashboardStats.completedStudies.toLocaleString()}
                  </div>
                  <div className="text-xs text-gray-500">Completed</div>
                </div>
                <div className="text-center p-1.5 bg-red-50 rounded">
                  <div className="text-sm font-semibold text-red-600">
                    {dashboardStats.urgentStudies.toLocaleString()}
                  </div>
                  <div className="text-xs text-gray-500">Urgent</div>
                </div>
                <div className="text-center p-1.5 bg-gray-50 rounded">
                  <div className="text-sm font-semibold text-gray-600">
                    {dashboardStats.totalStudies.toLocaleString()}
                  </div>
                  <div className="text-xs text-gray-500">Total</div>
                </div>
              </div>
            </div>
          </details>
        </div>
      </div>
    </div>
  );
});

export default LabDashboard;