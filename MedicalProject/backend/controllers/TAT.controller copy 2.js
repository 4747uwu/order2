import DicomStudy from '../models/dicomStudyModel.js';
import Lab from '../models/labModel.js';
import Doctor from '../models/doctorModel.js';
import ExcelJS from 'exceljs';
import mongoose from 'mongoose';
import NodeCache from 'node-cache';
import { calculateStudyTAT } from '../utils/TATutility.js';
import patient from '../models/patientModel.js';
import Document from '../models/documentModal.js';

// 🔧 PERFORMANCE: Advanced caching for TAT reports
const cache = new NodeCache({
    stdTTL: 600, // 10 minutes for reports
    checkperiod: 120,
    useClones: false
});

/**
 * 🔧 OPTIMIZED: Get all available locations (enhanced performance)
 */
export const getLocations = async (req, res) => {
    try {
        const startTime = Date.now();

        // 🔧 PERFORMANCE: Check cache first
        const cacheKey = 'tat_locations';
        let cachedLocations = cache.get(cacheKey);

        if (cachedLocations) {
            return res.status(200).json({
                success: true,
                locations: cachedLocations,
                performance: {
                    queryTime: Date.now() - startTime,
                    fromCache: true
                }
            });
        }

        // 🔧 OPTIMIZED: Lean query with minimal fields
        const labs = await Lab.find({ isActive: true })
            .select('name identifier')
            .lean();

        const locations = labs.map(lab => ({
            value: lab._id.toString(),
            label: lab.name,
            code: lab.identifier
        }));

        // 🔧 PERFORMANCE: Cache for 1 hour (locations don't change often)
        cache.set(cacheKey, locations, 3600);

        const processingTime = Date.now() - startTime;

        return res.status(200).json({
            success: true,
            locations,
            performance: {
                queryTime: processingTime,
                fromCache: false
            }
        });

    } catch (error) {
        console.error('❌ Error fetching locations:', error);
        return res.status(500).json({
            success: false,
            message: 'Failed to fetch locations',
            error: process.env.NODE_ENV === 'development' ? error.message : undefined
        });
    }
};

/**
 * 🔧 OPTIMIZED: Get all available statuses (enhanced performance)
 */
export const getStatuses = async (req, res) => {
    try {
        const startTime = Date.now();

        // 🔧 PERFORMANCE: Static data with caching
        const cacheKey = 'tat_statuses';
        let cachedStatuses = cache.get(cacheKey);

        if (cachedStatuses) {
            return res.status(200).json({
                success: true,
                statuses: cachedStatuses,
                performance: {
                    queryTime: Date.now() - startTime,
                    fromCache: true
                }
            });
        }

        // 🔧 OPTIMIZED: Based on actual enum values from dicomStudyModel
        const statuses = [
            { value: 'new_study_received', label: 'New Study' },
            { value: 'pending_assignment', label: 'Pending Assignment' },
            { value: 'assigned_to_doctor', label: 'Assigned to Doctor' },
            { value: 'doctor_opened_report', label: 'Doctor Opened Report' },
            { value: 'report_in_progress', label: 'Report In Progress' },
            { value: 'report_finalized', label: 'Report Finalized' },
            { value: 'report_uploaded', label: 'Report Uploaded' },
            { value: 'report_downloaded_radiologist', label: 'Downloaded by Radiologist' },
            { value: 'report_downloaded', label: 'Report Downloaded' },
            { value: 'final_report_downloaded', label: 'Final Report Downloaded' },
            { value: 'archived', label: 'Archived' }
        ];

        // 🔧 PERFORMANCE: Cache for 24 hours (statuses rarely change)
        cache.set(cacheKey, statuses, 86400);

        const processingTime = Date.now() - startTime;

        return res.status(200).json({
            success: true,
            statuses,
            performance: {
                queryTime: processingTime,
                fromCache: false
            }
        });

    } catch (error) {
        console.error('❌ Error fetching statuses:', error);
        return res.status(500).json({
            success: false,
            message: 'Failed to fetch statuses',
            error: process.env.NODE_ENV === 'development' ? error.message : undefined
        });
    }
};


/**
 * 🔧 HIGH-PERFORMANCE: Generate TAT report with advanced optimizations
 */
export const getTATReport = async (req, res) => {
    try {
        const startTime = Date.now();
        const { location, dateType, fromDate, toDate, status } = req.query;

        console.log(`🔍 Generating TAT report - Location: ${location || 'ALL'}, DateType: ${dateType}, From: ${fromDate}, To: ${toDate}`);

        // 🔧 ADD: Helper functions at the top of the function
        const formatStudyDate = (studyDate) => {
            if (!studyDate) return '-';
            
            if (typeof studyDate === 'string' && studyDate.length === 8) {
                const year = studyDate.substring(0, 4);
                const month = studyDate.substring(4, 6);
                const day = studyDate.substring(6, 8);
                return `${day}/${month}/${year}`;
            }
            
            if (studyDate instanceof Date) {
                return studyDate.toLocaleDateString('en-GB');
            }
            
            try {
                const date = new Date(studyDate);
                if (!isNaN(date.getTime())) {
                    return date.toLocaleDateString('en-GB');
                }
            } catch (error) {
                console.warn('Invalid study date format:', studyDate);
            }
            
            return studyDate?.toString() || '-';
        };

        const formatDate = (date) => {
            if (!date) return '-';
            try {
                return new Date(date).toLocaleString('en-GB');
            } catch (error) {
                console.warn('Invalid date format:', date);
                return date?.toString() || '-';
            }
        };

        // 🔧 MODIFIED: Location is no longer required - allow fetching from all locations
        // if (!location) {
        //     return res.status(400).json({
        //         success: false,
        //         message: 'Location is required'
        //     });
        // }

        // 🔧 MODIFIED: Cache key includes 'all' when no location specified
        const locationKey = location || 'all';
        const cacheKey = `tat_report_${locationKey}_${dateType}_${fromDate}_${toDate}_${status}`;
        let cachedReport = cache.get(cacheKey);

        if (cachedReport) {
            return res.status(200).json({
                success: true,
                ...cachedReport,
                performance: {
                    queryTime: Date.now() - startTime,
                    fromCache: true
                }
            });
        }

        // 🔧 OPTIMIZED: Build aggregation pipeline for maximum performance
        const pipeline = [];

        // 🔧 MODIFIED: Only add location filter if location is specified
        if (location) {
            pipeline.push({
                $match: {
                    sourceLab: new mongoose.Types.ObjectId(location)
                }
            });
        }

        // 🔧 PERFORMANCE: Add date filtering based on type
        if (fromDate && toDate) {
            const startDate = new Date(fromDate);
            startDate.setHours(0, 0, 0, 0);

            const endDate = new Date(toDate);
            endDate.setHours(23, 59, 59, 999);

            let dateFilter = {};

            switch (dateType) {
                case 'studyDate':
                    if (typeof fromDate === 'string' && fromDate.includes('-')) {
                        const fromDateStr = fromDate.replace(/-/g, '');
                        const toDateStr = toDate.replace(/-/g, '');
                        
                        dateFilter.$or = [
                            { 
                                studyDate: { 
                                    $type: "string",
                                    $gte: fromDateStr, 
                                    $lte: toDateStr 
                                }
                            },
                            { 
                                studyDate: { 
                                    $type: "date",
                                    $gte: startDate, 
                                    $lte: endDate 
                                }
                            }
                        ];
                    } else {
                        dateFilter.studyDate = { $gte: startDate, $lte: endDate };
                    }
                    break;

                case 'uploadDate':
                    dateFilter.createdAt = { $gte: startDate, $lte: endDate };
                    break;

                case 'assignedDate':
                    dateFilter['assignment.assignedAt'] = { $gte: startDate, $lte: endDate };
                    break;

                case 'reportDate':
                    dateFilter['reportInfo.finalizedAt'] = { $gte: startDate, $lte: endDate };
                    break;

                default:
                    dateFilter.createdAt = { $gte: startDate, $lte: endDate };
            }

            pipeline.push({ $match: dateFilter });
        }

        // 🔧 PERFORMANCE: Add status filter
        if (status) {
            pipeline.push({ $match: { workflowStatus: status } });
        }

        // 🔧 OPTIMIZED: Lookup related data efficiently in a single pass
        pipeline.push(
            {
                $lookup: {
                    from: 'patients',
                    localField: 'patient',
                    foreignField: '_id',
                    as: 'patientData',
                    pipeline: [{ $project: { patientID: 1, firstName: 1, lastName: 1, patientNameRaw: 1, gender: 1, 'computed.fullName': 1 } }]
                }
            },
            {
                $lookup: {
                    from: 'labs',
                    localField: 'sourceLab',
                    foreignField: '_id',
                    as: 'labData',
                    pipeline: [{ $project: { name: 1, identifier: 1 } }]
                }
            },
            {
                $lookup: {
                    from: 'doctors',
                    localField: 'assignment.assignedTo',
                    foreignField: '_id',
                    as: 'doctorData',
                    pipeline: [
                        { $lookup: { from: 'users', localField: 'userAccount', foreignField: '_id', as: 'userAccount' } },
                        { $project: { 'userAccount.fullName': 1, specialization: 1, _id: 1 } }
                    ]
                }
            },
            // 🆕 NEW: Lookup documents to get uploadedBy info for doctor filtering
            {
                $lookup: {
                    from: 'documents',
                    localField: '_id',
                    foreignField: 'studyId',
                    as: 'documentData',
                    pipeline: [
                        { $match: { documentType: 'clinical' } },
                        { $sort: { uploadedAt: -1 } }, // Get latest document
                        { $limit: 1 },
                        { 
                            $lookup: {
                                from: 'users',
                                localField: 'uploadedBy',
                                foreignField: '_id',
                                as: 'uploaderInfo',
                                pipeline: [{ $project: { fullName: 1, _id: 1 } }]
                            }
                        },
                        { $project: { uploadedBy: 1, uploaderInfo: { $arrayElemAt: ['$uploaderInfo', 0] } } }
                    ]
                }
            }
        );

        // 🔧 CRITICAL: Project only needed fields and explicitly include calculatedTAT
        pipeline.push({
            $project: {
                // Basic study info
                workflowStatus: 1, studyDate: 1, createdAt: 1, accessionNumber: 1,
                examDescription: 1, modality: 1, modalitiesInStudy: 1, referredBy: 1,
                seriesCount: 1, instanceCount: 1,
                // Assignment & Report Info
                assignment: 1, reportInfo: 1, doctorReports: 1, // 🔧 ADD: doctorReports
                // THE GOAL: Include the pre-calculated TAT object from the database
                calculatedTAT: 1,
                // Flattened lookups for easier access
                patient: { $arrayElemAt: ['$patientData', 0] },
                lab: { $arrayElemAt: ['$labData', 0] },
                doctor: { $arrayElemAt: ['$doctorData', 0] },
                documentData: { $arrayElemAt: ['$documentData', 0] } // 🆕 NEW: Document data for uploadedBy
            }
    });

        // 🔧 MODIFIED: Only sort, no pagination - fetch ALL studies
        pipeline.push({ $sort: { createdAt: -1 } });

        // 🔧 CRITICAL: Execute aggregation with allowDiskUse for large datasets
        console.log('🔍 Executing TAT aggregation pipeline...');
        const studies = await DicomStudy.aggregate(pipeline).allowDiskUse(true);
        
        console.log(`✅ Retrieved ALL ${studies.length} studies for the timeframe from ${location ? 'selected location' : 'ALL locations'}`);

        // 🔧 OPTIMIZED: Process studies efficiently, using the fetched calculatedTAT
        const processedStudies = studies.map(study => {
            const tat = study.calculatedTAT || calculateStudyTAT(study);
            const patient = study.patient || {};
            const patientName = patient.computed?.fullName ||
                (patient.firstName && patient.lastName ? `${patient.lastName}, ${patient.firstName}` : patient.patientNameRaw) || '-';

            const modality = study.modalitiesInStudy?.length > 0 ? 
                         study.modalitiesInStudy.join(', ') : (study.modality || 'N/A');
    
            // 🔧 ENHANCED: Get doctor info from assignment and reports
            const assignedDoctorId = study.assignment?.[0]?.assignedTo || study.assignment?.assignedTo;
            const reportedBy = study.reportInfo?.reporterName || study.doctor?.userAccount?.[0]?.fullName || '-';
            
            // 🆕 FIXED: Get uploadedBy from document data
            let uploadedById = null;
            if (study.documentData?.uploadedBy) {
                uploadedById = study.documentData.uploadedBy;
            } else if (assignedDoctorId) {
                // Fallback to assigned doctor if no document data
                uploadedById = assignedDoctorId;
            }

            return {
                _id: study._id,
                studyStatus: study.workflowStatus || '-',
                patientId: patient.patientID || '-',
                patientName,
                gender: patient.gender || '-',
                referredBy: study.referredBy || '-',
                accessionNumber: study.accessionNumber || '-',
                studyDescription: study.examDescription || '-',
                modality,
                series_Images: `${study.seriesCount || 0}/${study.instanceCount || 0}`,
                institutionName: study.lab?.name || '-',
                billedOnStudyDate: formatStudyDate(study.studyDate),
                uploadDate: formatDate(study.createdAt),
                assignedDate: formatDate(study.assignment?.[0]?.assignedAt || study.assignment?.assignedAt),
                reportDate: formatDate(study.reportInfo?.finalizedAt),
                reportedBy,
                
                // 🆕 FIXED: Add doctor IDs for filtering
                assignedDoctorId: assignedDoctorId ? assignedDoctorId.toString() : null,
                uploadedById: uploadedById ? uploadedById.toString() : null,
                
                // TAT fields
                diffStudyAndReportTAT: tat.studyToReportTATFormatted || '-',
                diffUploadAndReportTAT: tat.uploadToReportTATFormatted || '-',
                diffAssignAndReportTAT: tat.assignmentToReportTATFormatted || '-',
                uploadToAssignmentTAT: tat.uploadToAssignmentTATFormatted || '-',
                fullTatDetails: tat 
            };
        });

        // 🔧 PERFORMANCE: Calculate summary statistics using the already fetched `calculatedTAT`
        const reportedStudies = studies.filter(s => s.reportInfo?.finalizedAt);
        const summary = {
            totalStudies: studies.length,
            reportedStudies: reportedStudies.length,
            averageUploadToReport: reportedStudies.length > 0
                ? Math.round(reportedStudies.reduce((sum, s) => sum + (s.calculatedTAT?.uploadToReportTAT || 0), 0) / reportedStudies.length)
                : 0,
            averageAssignToReport: reportedStudies.length > 0
                ? Math.round(reportedStudies.reduce((sum, s) => sum + (s.calculatedTAT?.assignmentToReportTAT || 0), 0) / reportedStudies.length)
                : 0
        };

        const responseData = {
            studies: processedStudies,
            summary,
            totalRecords: studies.length
        };

        // 🔧 PERFORMANCE: Cache the result for 5 minutes
        cache.set(cacheKey, responseData, 300);

        const processingTime = Date.now() - startTime;
        console.log(`✅ TAT report generated in ${processingTime}ms - ALL ${studies.length} studies fetched from ${location ? 'selected location' : 'ALL locations'}`);

        return res.status(200).json({
            success: true,
            ...responseData,
            performance: {
                queryTime: processingTime,
                fromCache: false,
                studiesProcessed: studies.length
            }
        });

    } catch (error) {
        console.error('❌ Error generating TAT report:', error);
        return res.status(500).json({
            success: false,
            message: 'Failed to generate TAT report',
            error: process.env.NODE_ENV === 'development' ? error.message : undefined
        });
    }
};

// 🔧 MODIFIED: Export function also supports all locations
export const exportTATReport = async (req, res) => {
    try {
        const startTime = Date.now();
        // 🆕 ADD: Include selectedDoctor parameter
        const { location, dateType, fromDate, toDate, status, selectedDoctor } = req.query;

        console.log(`📊 Exporting TAT report - Location: ${location || 'ALL'}, Doctor: ${selectedDoctor || 'ALL'}`);

        // 🔧 CONSISTENCY: Use the same base pipeline as getTATReport
        const pipeline = [];

        // 🔧 MODIFIED: Only add location filter if location is specified
        if (location) {
            pipeline.push({ $match: { sourceLab: new mongoose.Types.ObjectId(location) } });
        }

        // Add date filtering
        if (fromDate && toDate) {
            const startDate = new Date(fromDate);
            startDate.setHours(0, 0, 0, 0);
            const endDate = new Date(toDate);
            endDate.setHours(23, 59, 59, 999);
            let dateFilter = {};
            switch(dateType) {
                case 'studyDate': 
                    if (typeof fromDate === 'string' && fromDate.includes('-')) {
                        const fromDateStr = fromDate.replace(/-/g, '');
                        const toDateStr = toDate.replace(/-/g, '');
                        dateFilter.$or = [
                            { studyDate: { $type: "string", $gte: fromDateStr, $lte: toDateStr } },
                            { studyDate: { $type: "date", $gte: startDate, $lte: endDate } }
                        ];
                    } else {
                        dateFilter.studyDate = { $gte: startDate, $lte: endDate };
                    }
                    break;
                case 'uploadDate': dateFilter.createdAt = { $gte: startDate, $lte: endDate }; break;
                case 'assignedDate': dateFilter['assignment.assignedAt'] = { $gte: startDate, $lte: endDate }; break;
                case 'reportDate': dateFilter['reportInfo.finalizedAt'] = { $gte: startDate, $lte: endDate }; break;
                default: dateFilter.createdAt = { $gte: startDate, $lte: endDate };
            }
            pipeline.push({ $match: dateFilter });
        }

        if (status) {
            pipeline.push({ $match: { workflowStatus: status } });
        }

        // 🆕 CRITICAL: Doctor filtering logic - BEFORE lookups to optimize performance
        if (selectedDoctor) {
            console.log(`🔍 Applying doctor filter for user ID: ${selectedDoctor}`);
            
            // Step 1: Get all document IDs that belong to this doctor
            const doctorDocuments = await mongoose.connection.db.collection('documents').find(
                { 
                    uploadedBy: new mongoose.Types.ObjectId(selectedDoctor),
                    documentType: 'clinical',
                    isActive: true
                },
                { projection: { _id: 1 } }
            ).toArray();
            
            const doctorDocumentIds = doctorDocuments.map(doc => doc._id);
            console.log(`📋 Found ${doctorDocumentIds.length} documents uploaded by selected doctor`);

            if (doctorDocumentIds.length > 0) {
                // Step 2: Filter studies that have doctorReports._id matching any of these document IDs
                // OR studies assigned to this doctor (fallback)
                pipeline.push({
                    $match: {
                        $or: [
                            { 'doctorReports._id': { $in: doctorDocumentIds } },
                            { 'assignment.assignedTo': new mongoose.Types.ObjectId(selectedDoctor) }
                        ]
                    }
                });
            } else {
                // If no documents found, only match assigned studies
                pipeline.push({
                    $match: { 'assignment.assignedTo': new mongoose.Types.ObjectId(selectedDoctor) }
                });
            }
        }
        
        // 🔧 ENHANCED: Add same lookups as getTATReport INCLUDING document lookup
        pipeline.push(
            {
                $lookup: {
                    from: 'patients',
                    localField: 'patient',
                    foreignField: '_id',
                    as: 'patientData',
                    pipeline: [{ $project: { patientID: 1, firstName: 1, lastName: 1, patientNameRaw: 1, gender: 1, 'computed.fullName': 1 } }]
                }
            },
            {
                $lookup: {
                    from: 'labs',
                    localField: 'sourceLab',
                    foreignField: '_id',
                    as: 'labData',
                    pipeline: [{ $project: { name: 1, identifier: 1 } }]
                }
            },
            {
                $lookup: {
                    from: 'doctors',
                    localField: 'assignment.assignedTo',
                    foreignField: '_id',
                    as: 'doctorData',
                    pipeline: [
                        { $lookup: { from: 'users', localField: 'userAccount', foreignField: '_id', as: 'userAccount' } },
                        { $project: { 'userAccount.fullName': 1, specialization: 1, _id: 1 } }
                    ]
                }
            },
            // 🆕 CRITICAL: Add document lookup to get uploadedBy info
            {
                $lookup: {
                    from: 'documents',
                    localField: 'doctorReports._id',
                    foreignField: '_id',
                    as: 'documentData',
                    pipeline: [
                        { $match: { documentType: 'clinical', isActive: true } },
                        { $sort: { uploadedAt: -1 } },
                        { $limit: 1 },
                        { 
                            $lookup: {
                                from: 'users',
                                localField: 'uploadedBy',
                                foreignField: '_id',
                                as: 'uploaderInfo',
                                pipeline: [{ $project: { fullName: 1, _id: 1 } }]
                            }
                        },
                        { $project: { uploadedBy: 1, uploaderInfo: { $arrayElemAt: ['$uploaderInfo', 0] } } }
                    ]
                }
            }
        );

        pipeline.push({
            $project: {
                workflowStatus: 1, studyDate: 1, createdAt: 1, accessionNumber: 1,
                examDescription: 1, modality: 1, modalitiesInStudy: 1, referredBy: 1,
                seriesCount: 1, instanceCount: 1, assignment: 1, reportInfo: 1,
                calculatedTAT: 1, // Include calculatedTAT
                patientData: { $arrayElemAt: ['$patientData', 0] },
                labData: { $arrayElemAt: ['$labData', 0] },
                doctorData: { $arrayElemAt: ['$doctorData', 0] },
                documentData: { $arrayElemAt: ['$documentData', 0] } // 🆕 ADD: Document data for verification
            }
        });

        // 🔧 PERFORMANCE: Create Excel workbook with streaming
        const workbook = new ExcelJS.stream.xlsx.WorkbookWriter({ stream: res, useStyles: true });
        const worksheet = workbook.addWorksheet('TAT Report');

        // 🔧 ENHANCED: Update filename to include doctor info
        let fileName = 'TAT_Report';
        if (location) {
            const lab = await Lab.findById(location);
            fileName += `_${lab?.name?.replace(/[^a-zA-Z0-9]/g, '_') || 'Unknown'}`;
        } else {
            fileName += '_All_Locations';
        }
        
        // 🆕 ADD: Include doctor name in filename if filtering
        if (selectedDoctor) {
            try {
                // Get doctor user info directly
                const doctorUser = await mongoose.connection.db.collection('users').findOne(
                    { _id: new mongoose.Types.ObjectId(selectedDoctor) },
                    { projection: { fullName: 1 } }
                );
                const doctorName = doctorUser?.fullName?.replace(/[^a-zA-Z0-9]/g, '_') || 'Unknown_Doctor';
                fileName += `_${doctorName}`;
            } catch (error) {
                fileName += '_Selected_Doctor';
            }
        }
        
        fileName += `_${new Date().toISOString().split('T')[0]}.xlsx`;
        
        res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
        res.setHeader('Content-Disposition', `attachment; filename="${fileName}"`);
        
        // 🔧 ENHANCED: More comprehensive Excel columns
        worksheet.columns = [
            { header: 'Study Status', key: 'studyStatus', width: 20 },
            { header: 'Patient ID', key: 'patientId', width: 15 },
            { header: 'Patient Name', key: 'patientName', width: 25 },
            { header: 'Gender', key: 'gender', width: 10 },
            { header: 'Referred By', key: 'referredBy', width: 20 },
            { header: 'Accession No', key: 'accessionNumber', width: 20 },
            { header: 'Study Description', key: 'studyDescription', width: 30 },
            { header: 'Modality', key: 'modality', width: 15 },
            { header: 'Series/Images', key: 'seriesImages', width: 15 },
            { header: 'Institution', key: 'institution', width: 25 },
            { header: 'Study Date', key: 'studyDate', width: 20 },
            { header: 'Upload Date', key: 'uploadDate', width: 20 },
            { header: 'Assigned Date', key: 'assignedDate', width: 20 },
            { header: 'Report Date', key: 'reportDate', width: 20 },
            { header: 'Upload-to-Assign TAT (min)', key: 'uploadToAssignment', width: 25 },
            { header: 'Upload-to-Report TAT (min)', key: 'uploadToReport', width: 25 },
            { header: 'Assign-to-Report TAT (min)', key: 'assignToReport', width: 25 },
            { header: 'Reported By', key: 'reportedBy', width: 25 },
            // 🆕 ADD: Verification columns for debugging
            { header: 'Assigned Doctor ID', key: 'assignedDoctorId', width: 25 },
            { header: 'Report Uploader ID', key: 'uploadedById', width: 25 },
            { header: 'Report Uploader Name', key: 'uploaderName', width: 25 }
        ];
        
        // 🔧 STYLING: Make header row bold and with background color
        const headerRow = worksheet.getRow(1);
        headerRow.font = { bold: true, color: { argb: 'FFFFFF' } };
        headerRow.fill = {
            type: 'pattern',
            pattern: 'solid',
            fgColor: { argb: '366092' }
        };
        headerRow.alignment = { horizontal: 'center', vertical: 'middle' };

        // 🔧 FIXED: Apply allowDiskUse before cursor, not after
        const cursor = DicomStudy.aggregate(pipeline)
            .allowDiskUse(true)
            .cursor({ batchSize: 200 });
        
        let processedCount = 0;
        let doctorFilteredCount = 0;

        // Helper function to format study date
        const formatStudyDate = (studyDate) => {
            if (!studyDate) return '-';
            
            if (typeof studyDate === 'string' && studyDate.length === 8) {
                const year = studyDate.substring(0, 4);
                const month = studyDate.substring(4, 6);
                const day = studyDate.substring(6, 8);
                return `${day}/${month}/${year}`;
            }
            
            if (studyDate instanceof Date) {
                return studyDate.toLocaleDateString('en-GB');
            }
            
            try {
                const date = new Date(studyDate);
                if (!isNaN(date.getTime())) {
                    return date.toLocaleDateString('en-GB');
                }
            } catch (error) {
                console.warn('Invalid study date format:', studyDate);
            }
            
            return studyDate.toString();
        };

        // 🔧 FIXED: Better error handling for cursor iteration
        try {
            for (let study = await cursor.next(); study != null; study = await cursor.next()) {
                // 🔧 CONSISTENCY: Use calculatedTAT, with fallback, same as getTATReport
                const tat = study.calculatedTAT || calculateStudyTAT(study);

                const patient = study.patientData || {};
                const lab = study.labData || {};
                const doctor = study.doctorData || {};
                
                const formatDate = (date) => date ? new Date(date).toLocaleString('en-GB') : '-';
                const patientName = patient.computed?.fullName ||
                    (patient.firstName && patient.lastName ? `${patient.lastName}, ${patient.firstName}` : patient.patientNameRaw) || '-';

                // 🆕 EXTRACT: Doctor IDs and names for verification
                const assignedDoctorId = study.assignment?.[0]?.assignedTo || study.assignment?.assignedTo;
                const uploadedById = study.documentData?.uploadedBy;
                const uploaderName = study.documentData?.uploaderInfo?.fullName || '-';

                const row = worksheet.addRow({
                    studyStatus: study.workflowStatus || '-',
                    patientId: patient.patientID || '-',
                    patientName,
                    gender: patient.gender || '-',
                    referredBy: study.referredBy || '-',
                    accessionNumber: study.accessionNumber || '-',
                    studyDescription: study.examDescription || '-',
                    modality: study.modalitiesInStudy?.join(', ') || '-',
                    seriesImages: `${study.seriesCount || 0}/${study.instanceCount || 0}`,
                    institution: lab.name || '-',
                    studyDate: formatStudyDate(study.studyDate),
                    uploadDate: formatDate(study.createdAt),
                    assignedDate: formatDate(study.assignment?.[0]?.assignedAt || study.assignment?.assignedAt),
                    reportDate: formatDate(study.reportInfo?.finalizedAt),
                    uploadToAssignment: tat.uploadToAssignmentTAT || 'N/A',
                    uploadToReport: tat.uploadToReportTAT || 'N/A',
                    assignToReport: tat.assignmentToReportTAT || 'N/A',
                    reportedBy: study.reportInfo?.reporterName || doctor.userAccount?.[0]?.fullName || '-',
                    // 🆕 ADD: Verification columns
                    assignedDoctorId: assignedDoctorId?.toString() || '-',
                    uploadedById: uploadedById?.toString() || '-',
                    uploaderName: uploaderName
                });

                // 🔧 STYLING: Alternate row colors for better readability
                if (processedCount % 2 === 0) {
                    row.fill = {
                        type: 'pattern',
                        pattern: 'solid',
                        fgColor: { argb: 'F8F9FA' }
                    };
                }

                row.commit();
                processedCount++;
                
                // 🆕 TRACK: Studies that match selected doctor
                if (selectedDoctor && (
                    assignedDoctorId?.toString() === selectedDoctor || 
                    uploadedById?.toString() === selectedDoctor
                )) {
                    doctorFilteredCount++;
                }
            }

            await workbook.commit();
            const processingTime = Date.now() - startTime;
            
            const logMessage = selectedDoctor 
                ? `✅ TAT Excel export completed in ${processingTime}ms - ${processedCount} records for selected doctor (${doctorFilteredCount} matched by doctor ID) from ${location ? 'selected location' : 'ALL locations'}`
                : `✅ TAT Excel export completed in ${processingTime}ms - ${processedCount} records from ${location ? 'selected location' : 'ALL locations'}`;
            
            console.log(logMessage);

        } catch (cursorError) {
            console.error('❌ Error during cursor iteration:', cursorError);
            
            // Close cursor if it exists
            if (cursor && typeof cursor.close === 'function') {
                await cursor.close();
            }
            
            // Only send error response if headers haven't been sent
            if (!res.headersSent) {
                res.status(500).json({ 
                    success: false, 
                    message: 'Failed to export TAT report', 
                    error: cursorError.message 
                });
            }
        }

    } catch (error) {
        console.error('❌ Error exporting TAT report:', error);
        if (!res.headersSent) {
            res.status(500).json({ 
                success: false, 
                message: 'Failed to export TAT report', 
                error: error.message 
            });
        }
    }
};

/**
 * 🔧 ADDITIONAL: Get TAT analytics dashboard (Now using calculatedTAT)
 */
export const getTATAnalytics = async (req, res) => {
    try {
        const startTime = Date.now();
        const { location, period = '30d' } = req.query;

        if (!location) {
            return res.status(400).json({ success: false, message: 'Location is required' });
        }

        const cacheKey = `tat_analytics_v2_${location}_${period}`;
        let cachedAnalytics = cache.get(cacheKey);

        if (cachedAnalytics) {
            return res.status(200).json({ success: true, data: cachedAnalytics, performance: { queryTime: Date.now() - startTime, fromCache: true } });
        }

        const endDate = new Date();
        const startDate = new Date();
        const days = period === '7d' ? 7 : (period === '90d' ? 90 : 30);
        startDate.setDate(startDate.getDate() - days);

        // 🔧 CONSISTENCY: Analytics now based on the accurate `calculatedTAT` object
        const analyticsData = await DicomStudy.aggregate([
            { $match: { sourceLab: new mongoose.Types.ObjectId(location), createdAt: { $gte: startDate, $lte: endDate } } },
            {
                $group: {
                    _id: null,
                    totalStudies: { $sum: 1 },
                    completedStudies: { $sum: { $cond: ['$calculatedTAT.isCompleted', 1, 0] } },
                    avgUploadToReport: { $avg: '$calculatedTAT.uploadToReportTAT' },
                    avgAssignmentToReport: { $avg: '$calculatedTAT.assignmentToReportTAT' },
                    overdueStudies: { $sum: { $cond: ['$calculatedTAT.isOverdue', 1, 0] } }
                }
            }
        ]);

        const raw = analyticsData[0] || {};
        const formatMinutes = (mins) => {
            if (!mins || mins <= 0) return 'N/A';
            const hours = Math.floor(mins / 60);
            const minutes = Math.round(mins % 60);
            return `${hours}h ${minutes}m`;
        };

        const analytics = {
            totalStudies: raw.totalStudies || 0,
            completedStudies: raw.completedStudies || 0,
            overdueStudies: raw.overdueStudies || 0,
            completionRate: raw.totalStudies > 0 ? ((raw.completedStudies / raw.totalStudies) * 100).toFixed(1) : '0.0',
            avgUploadToReport: formatMinutes(raw.avgUploadToReport),
            avgAssignmentToReport: formatMinutes(raw.avgAssignmentToReport),
        };
        
        cache.set(cacheKey, analytics, 900); // Cache for 15 minutes

        return res.status(200).json({
            success: true,
            data: analytics,
            performance: { queryTime: Date.now() - startTime, fromCache: false }
        });

    } catch (error) {
        console.error('❌ Error generating TAT analytics:', error);
        return res.status(500).json({
            success: false,
            message: 'Failed to generate TAT analytics',
            error: process.env.NODE_ENV === 'development' ? error.message : undefined
        });
    }
};

// Add this new function to get all doctors
export const getDoctors = async (req, res) => {
    try {
        const startTime = Date.now();

        const cacheKey = 'tat_doctors';
        let cachedDoctors = cache.get(cacheKey);

        if (cachedDoctors) {
            return res.status(200).json({
                success: true,
                doctors: cachedDoctors,
                performance: { queryTime: Date.now() - startTime, fromCache: true }
            });
        }

        // 🔧 ENHANCED: Get doctors who have actually uploaded reports
        const doctors = await Doctor.aggregate([
            {
                $lookup: {
                    from: 'users',
                    localField: 'userAccount',
                    foreignField: '_id',
                    as: 'userAccount',
                    pipeline: [
                        { $match: { role: 'doctor_account', isActive: true } },
                        { $project: { fullName: 1, username: 1, email: 1, _id: 1 } }
                    ]
                }
            },
            {
                $match: {
                    userAccount: { $ne: [] },
                    isActiveProfile: true
                }
            },
            // 🆕 NEW: Lookup documents to see which doctors have uploaded reports
            {
                $lookup: {
                    from: 'documents',
                    localField: 'userAccount._id',
                    foreignField: 'uploadedBy',
                    as: 'uploadedDocuments',
                    pipeline: [
                        { $match: { documentType: 'clinical' } },
                        { $group: { _id: null, count: { $sum: 1 } } }
                    ]
                }
            },
            {
                $project: {
                    _id: 1,
                    specialization: 1,
                    userAccount: { $arrayElemAt: ['$userAccount', 0] },
                    reportCount: { $ifNull: [{ $arrayElemAt: ['$uploadedDocuments.count', 0] }, 0] }
                }
            },
            { $sort: { 'userAccount.fullName': 1 } }
        ]);

        const formattedDoctors = doctors.map(doctor => ({
            value: doctor.userAccount._id.toString(), // 🔧 CHANGED: Use user ID instead of doctor ID
            label: doctor.userAccount.fullName,
            uploadedBy: documents.uploadedBy, // For reference
            specialization: doctor.specialization || 'N/A',
            email: doctor.userAccount.email,
            reportCount: doctor.reportCount || 0,
            doctorId: doctor._id.toString() // Keep doctor ID for reference
        }));

        cache.set(cacheKey, formattedDoctors, 1800);

        return res.status(200).json({
            success: true,
            doctors: formattedDoctors,
            performance: { queryTime: Date.now() - startTime, fromCache: false }
        });

    } catch (error) {
        console.error('❌ Error fetching doctors:', error);
        return res.status(500).json({
            success: false,
            message: 'Failed to fetch doctors',
            error: process.env.NODE_ENV === 'development' ? error.message : undefined
        });
    }
};

export default {
    getLocations,
    getStatuses,
    getDoctors,
    getTATReport,
    exportTATReport,
    getTATAnalytics
};