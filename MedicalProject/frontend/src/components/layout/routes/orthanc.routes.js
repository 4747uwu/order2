import express from 'express';
import axios from 'axios';
import mongoose from 'mongoose';
import Redis from 'ioredis';
import websocketService from '../config/webSocket.js';
// 🔧 FIXED: Import the correct service name
import CloudflareR2ZipService from '../services/wasabi.zip.service.js';

// Import Mongoose Models
import DicomStudy from '../models/dicomStudyModel.js';
import Patient from '../models/patientModel.js';
import Lab from '../models/labModel.js';

const router = express.Router();

// --- Configuration ---
const ORTHANC_BASE_URL = process.env.ORTHANC_URL || 'http://localhost:8042';
const ORTHANC_USERNAME = process.env.ORTHANC_USERNAME || 'alice';
const ORTHANC_PASSWORD = process.env.ORTHANC_PASSWORD || 'alicePassword';
const orthancAuth = 'Basic ' + Buffer.from(ORTHANC_USERNAME + ':' + ORTHANC_PASSWORD).toString('base64');

// --- Redis Setup ---
const REDIS_URL = process.env.REDIS_URL || 'redis://localhost:6379';
const redis = new Redis(REDIS_URL, {
  maxRetriesPerRequest: 3,
  retryDelayOnFailover: 100,
  tls: {},
  lazyConnect: true,
});

// --- Simple Job Queue for Stable Studies ---
class StableStudyQueue {
  constructor() {
    this.jobs = new Map();
    this.processing = new Set();
    this.nextJobId = 1;
    this.isProcessing = false;
    this.concurrency = 10; // Process max 10 stable studies simultaneously
  }

  async add(jobData) {
    const jobId = this.nextJobId++;
    const job = {
      id: jobId,
      type: 'process-stable-study',
      data: jobData,
      status: 'waiting',
      createdAt: new Date(),
      progress: 0,
      result: null,
      error: null
    };
    
    this.jobs.set(jobId, job);
    console.log(`📝 Stable Study Job ${jobId} queued`);
    
    if (!this.isProcessing) {
      this.startProcessing();
    }
    
    return job;
  }

  async startProcessing() {
    if (this.isProcessing) return;
    this.isProcessing = true;
    
    console.log('🚀 Stable Study Queue processor started');
    
    while (this.getWaitingJobs().length > 0 || this.processing.size > 0) {
      while (this.processing.size < this.concurrency && this.getWaitingJobs().length > 0) {
        const waitingJobs = this.getWaitingJobs();
        if (waitingJobs.length > 0) {
          const job = waitingJobs[0];
          this.processJob(job);
        }
      }
      
      await new Promise(resolve => setTimeout(resolve, 100));
    }
    
    this.isProcessing = false;
    console.log('⏹️ Stable Study Queue processor stopped');
  }

  async processJob(job) {
    this.processing.add(job.id);
    job.status = 'active';
    
    console.log(`🚀 Processing Stable Study Job ${job.id}`);
    
    try {
      job.result = await processStableStudy(job);
      job.status = 'completed';
      console.log(`✅ Stable Study Job ${job.id} completed successfully`);
      
    } catch (error) {
      job.error = error.message;
      job.status = 'failed';
      console.error(`❌ Stable Study Job ${job.id} failed:`, error.message);
      console.error(`❌ Stack:`, error.stack);
    } finally {
      this.processing.delete(job.id);
    }
  }

  getWaitingJobs() {
    return Array.from(this.jobs.values()).filter(job => job.status === 'waiting');
  }

  getJob(jobId) {
    return this.jobs.get(jobId);
  }

  getJobByRequestId(requestId) {
    return Array.from(this.jobs.values()).find(job => job.data.requestId === requestId);
  }
}

const jobQueue = new StableStudyQueue();

// --- Helper Functions ---

function processDicomPersonName(dicomNameField) {
  if (!dicomNameField || typeof dicomNameField !== 'string') {
    return {
      fullName: 'Unknown Patient',
      firstName: '',
      lastName: 'Unknown',
      middleName: '',
      namePrefix: '',
      nameSuffix: '',
      originalDicomFormat: dicomNameField || '',
      formattedForDisplay: 'Unknown Patient'
    };
  }

  const nameString = dicomNameField.trim();
  
  // Handle empty or whitespace-only names
  if (nameString === '' || nameString === '^' || nameString === '^^^') {
    return {
      fullName: 'Anonymous Patient',
      firstName: '',
      lastName: 'Anonymous',
      middleName: '',
      namePrefix: '',
      nameSuffix: '',
      originalDicomFormat: nameString,
      formattedForDisplay: 'Anonymous Patient'
    };
  }

  // Split by ^ (DICOM person name format: Family^Given^Middle^Prefix^Suffix)
  const parts = nameString.split('^');
  const familyName = (parts[0] || '').trim();
  const givenName = (parts[1] || '').trim();
  const middleName = (parts[2] || '').trim();
  const namePrefix = (parts[3] || '').trim();
  const nameSuffix = (parts[4] || '').trim();

  // Create display name
  const nameParts = [];
  if (namePrefix) nameParts.push(namePrefix);
  if (givenName) nameParts.push(givenName);
  if (middleName) nameParts.push(middleName);
  if (familyName) nameParts.push(familyName);
  if (nameSuffix) nameParts.push(nameSuffix);

  const displayName = nameParts.length > 0 ? nameParts.join(' ') : 'Unknown Patient';

  return {
    fullName: displayName,
    firstName: givenName,
    lastName: familyName,
    middleName: middleName,
    namePrefix: namePrefix,
    nameSuffix: nameSuffix,
    originalDicomFormat: nameString,
    formattedForDisplay: displayName
  };
}

// 🔧 ENHANCED: Fix DICOM date parsing
function formatDicomDateToISO(dicomDate) {
  if (!dicomDate || typeof dicomDate !== 'string') return null;
  
  // Handle different DICOM date formats
  let cleanDate = dicomDate.trim();
  
  // Handle YYYYMMDD format (standard DICOM)
  if (cleanDate.length === 8 && /^\d{8}$/.test(cleanDate)) {
    try {
      const year = cleanDate.substring(0, 4);
      const month = cleanDate.substring(4, 6);
      const day = cleanDate.substring(6, 8);
      
      // Validate date components
      const yearNum = parseInt(year);
      const monthNum = parseInt(month);
      const dayNum = parseInt(day);
      
      if (yearNum >= 1900 && yearNum <= 2100 && monthNum >= 1 && monthNum <= 12 && dayNum >= 1 && dayNum <= 31) {
        return new Date(`${year}-${month}-${day}T00:00:00.000Z`);
      }
    } catch (error) {
      console.warn('Error parsing DICOM date:', dicomDate, error);
    }
  }
  
  // Handle other formats or return current date as fallback
  try {
    const parsed = new Date(cleanDate);
    if (!isNaN(parsed.getTime()) && parsed.getFullYear() > 1900) {
      return parsed;
    }
  } catch (error) {
    console.warn('Error parsing date:', dicomDate, error);
  }
  
  // Return current date as fallback
  return new Date();
}

async function findOrCreatePatientFromTags(tags) {
  const patientIdDicom = tags.PatientID;
  const nameInfo = processDicomPersonName(tags.PatientName);
  const patientSex = tags.PatientSex;
  const patientBirthDate = tags.PatientBirthDate;

  if (!patientIdDicom && !nameInfo.fullName) {
    let unknownPatient = await Patient.findOne({ mrn: 'UNKNOWN_STABLE_STUDY' });
    if (!unknownPatient) {
      unknownPatient = await Patient.create({
        mrn: 'UNKNOWN_STABLE_STUDY',
        patientID: 'UNKNOWN_PATIENT',
        patientNameRaw: 'Unknown Patient (Stable Study)',
        firstName: '',
        lastName: '',
        gender: patientSex || '',
        dateOfBirth: patientBirthDate || '',
        isAnonymous: true
      });
    }
    return unknownPatient;
  }

  let patient = await Patient.findOne({ mrn: patientIdDicom });

  if (!patient) {
    patient = new Patient({
      mrn: patientIdDicom || `ANON_${Date.now()}`,
      patientID: patientIdDicom || `ANON_${Date.now()}`,
      patientNameRaw: nameInfo.formattedForDisplay,
      firstName: nameInfo.firstName,
      lastName: nameInfo.lastName,
      computed: {
        fullName: nameInfo.formattedForDisplay,
        namePrefix: nameInfo.namePrefix,
        nameSuffix: nameInfo.nameSuffix,
        originalDicomName: nameInfo.originalDicomFormat
      },
      gender: patientSex || '',
      dateOfBirth: patientBirthDate ? formatDicomDateToISO(patientBirthDate) : ''
    });
    
    await patient.save();
    console.log(`👤 Created patient: ${nameInfo.formattedForDisplay} (${patientIdDicom})`);
  } else {
    // Update existing patient if name format has improved
    if (patient.patientNameRaw && patient.patientNameRaw.includes('^') && nameInfo.formattedForDisplay && !nameInfo.formattedForDisplay.includes('^')) {
      console.log(`🔄 Updating patient name format from "${patient.patientNameRaw}" to "${nameInfo.formattedForDisplay}"`);
      
      patient.patientNameRaw = nameInfo.formattedForDisplay;
      patient.firstName = nameInfo.firstName;
      patient.lastName = nameInfo.lastName;
      
      if (!patient.computed) patient.computed = {};
      patient.computed.fullName = nameInfo.formattedForDisplay;
      patient.computed.originalDicomName = nameInfo.originalDicomFormat;
      
      await patient.save();
    }
  }
  
  return patient;
}

async function findOrCreateSourceLab(tags) {
  const DEFAULT_LAB = {
    name: 'Unknown Lab (No Identifier Found)',
    identifier: 'UNKNOWN_LAB',
    isActive: true,
  };

  try {
    // 🎯 ONLY CHECK THESE SPECIFIC PRIVATE TAGS - NO FALLBACKS
    const privateTags = ["0013,0010", "0015,0010", "0021,0010", "0043,0010"];
    
    console.log(`[StableStudy] 🔍 Checking private tags for lab identifier...`);
    console.log(`[StableStudy] 📋 Available tags:`, {
      "0013,0010": tags["0013,0010"] || 'NOT_FOUND',
      "0015,0010": tags["0015,0010"] || 'NOT_FOUND', 
      "0021,0010": tags["0021,0010"] || 'NOT_FOUND',
      "0043,0010": tags["0043,0010"] || 'NOT_FOUND'
    });
    
    for (const tag of privateTags) {
      const tagValue = tags[tag];
      
      // 🔧 FIX: Check for "SRJ" or any valid lab identifier (not default values)
      if (tagValue && tagValue.trim() !== '' && tagValue !== 'xcenticlab') {
        const labIdentifier = tagValue.trim();
        console.log(`[StableStudy] ✅ Found lab identifier in tag [${tag}]: ${labIdentifier}`);
        
        try {
          // Direct lookup by identifier field (case insensitive)
          const labByIdentifier = await Lab.findOne({ 
            identifier: { $regex: new RegExp(`^${escapeRegex(labIdentifier)}$`, 'i') },
            isActive: true 
          });
          
          if (labByIdentifier) {
            console.log(`[StableStudy] ✅ Found lab: ${labByIdentifier.name} (${labByIdentifier.identifier})`);
            return labByIdentifier;
          } else {
            console.warn(`[StableStudy] ⚠️ No lab found with identifier: ${labIdentifier}`);
            
            // 🔧 CREATE LAB: Auto-create lab if identifier is found but lab doesn't exist
            console.log(`[StableStudy] 🆕 Creating new lab with identifier: ${labIdentifier}`);
            const newLab = new Lab({
              name: `${labIdentifier} Laboratory`,
              identifier: labIdentifier.toUpperCase(),
              isActive: true,
              notes: `Auto-created from private DICOM tag [${tag}] with value "${labIdentifier}" on ${new Date().toISOString()}`
            });
            await newLab.save();
            console.log(`[StableStudy] ✅ Created new lab: ${newLab.name} (${newLab.identifier})`);
            return newLab;
          }
          
        } catch (labLookupError) {
          console.error(`[StableStudy] ❌ Error looking up lab with identifier ${labIdentifier}:`, labLookupError.message);
        }
      } else {
        console.log(`[StableStudy] 📋 Tag [${tag}] is empty or contains default value: ${tagValue || 'EMPTY'}`);
      }
    }
    
    // 🚫 NO FALLBACKS - If no private tag found, use unknown lab
    console.warn(`[StableStudy] ⚠️ No valid lab identifier found in any private tags`);
    
    // Find or create the unknown lab
    let unknownLab = await Lab.findOne({ identifier: DEFAULT_LAB.identifier });
    
    if (!unknownLab) {
      console.log(`[StableStudy] 🆕 Creating unknown lab: ${DEFAULT_LAB.name}`);
      unknownLab = new Lab({
        ...DEFAULT_LAB,
        notes: `Unknown lab created because no valid lab identifier was found in private tags [0013,0010], [0015,0010], [0021,0010], [0043,0010]. Created on ${new Date().toISOString()}`
      });
      await unknownLab.save();
    }

    console.log(`[StableStudy] 🔄 Using unknown lab: ${unknownLab.name}`);
    return unknownLab;

  } catch (error) {
    console.error('❌ Error in findOrCreateSourceLab:', error);
    
    // Emergency fallback - find any active lab
    let emergencyLab = await Lab.findOne({ isActive: true });
    if (!emergencyLab) {
      emergencyLab = new Lab({
        name: 'Emergency Default Lab',
        identifier: 'EMERGENCY_DEFAULT',
        isActive: true,
        notes: `Emergency lab created due to system error. Created on ${new Date().toISOString()}`
      });
      await emergencyLab.save();
    }
    
    console.log(`[StableStudy] 🚨 Using emergency lab: ${emergencyLab.name}`);
    return emergencyLab;
  }
}

function escapeRegex(string) {
  return string.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

// --- Main Processing Function ---
async function processStableStudy(job) {
  const { orthancStudyId, requestId } = job.data;
  const startTime = Date.now();
  
  try {
    console.log(`[StableStudy] 🚀 Processing stable study: ${orthancStudyId}`);
    job.progress = 10;
    
    // 🔧 OPTIMIZED: Single API call to get all series info (EXACTLY AS YOUR CODE)
    const seriesUrl = `${ORTHANC_BASE_URL}/studies/${orthancStudyId}/series`;
    console.log(`[StableStudy] 🌐 Fetching series from: ${seriesUrl}`);
    
    const seriesResponse = await axios.get(seriesUrl, {
      headers: { 'Authorization': orthancAuth },
      timeout: 10000
    });
    
    const allSeries = seriesResponse.data;
    console.log(`[StableStudy] 📊 Found ${allSeries.length} series`);
    
    job.progress = 30;
    
    // 🔧 OPTIMIZED: Extract modalities and counts from series data (EXACTLY AS YOUR CODE)
    const modalitiesSet = new Set();
    let totalInstances = 0;
    let firstInstanceId = null;
    
    // Process all series to get modalities and instance counts
    for (const series of allSeries) {
      const modality = series.MainDicomTags?.Modality;
      if (modality) {
        modalitiesSet.add(modality);
      }
      
      const instanceCount = series.Instances?.length || 0;
      totalInstances += instanceCount;
      
      // Get first instance ID for tag extraction (only if we don't have one yet)
      if (!firstInstanceId && series.Instances && series.Instances.length > 0) {
        firstInstanceId = series.Instances[0];
      }
    }
    
    console.log(`[StableStudy] 📊 Optimized counts - Series: ${allSeries.length}, Total Instances: ${totalInstances}`);
    console.log(`[StableStudy] 📊 Modalities found: ${Array.from(modalitiesSet).join(', ')}`);
    
    job.progress = 50;
    
    // 🔧 OPTIMIZED: Single API call to get tags from first instance only (EXACTLY AS YOUR CODE)
    let tags = {};
    
    if (firstInstanceId) {
      console.log(`[StableStudy] 🔍 Getting tags from single instance: ${firstInstanceId}`);
      
      try {
        const metadataUrl = `${ORTHANC_BASE_URL}/instances/${firstInstanceId}/tags`;
        const metadataResponse = await axios.get(metadataUrl, {
          headers: { 'Authorization': orthancAuth },
          timeout: 8000
        });
        
        const rawTags = metadataResponse.data;
        
        // 🔧 OPTIMIZED: Extract all necessary tags in one pass (EXACTLY AS YOUR CODE)
        tags = {};
        for (const [tagKey, tagData] of Object.entries(rawTags)) {
          if (tagData && typeof tagData === 'object' && tagData.Value !== undefined) {
            tags[tagKey] = tagData.Value;
          } else if (typeof tagData === 'string') {
            tags[tagKey] = tagData;
          }
        }
        
        // Map common DICOM fields (EXACTLY AS YOUR CODE)
        tags.PatientName = rawTags["0010,0010"]?.Value || tags.PatientName;
        tags.PatientID = rawTags["0010,0020"]?.Value || tags.PatientID;
        tags.PatientSex = rawTags["0010,0040"]?.Value || tags.PatientSex;
        tags.PatientBirthDate = rawTags["0010,0030"]?.Value || tags.PatientBirthDate;
        tags.StudyDescription = rawTags["0008,1030"]?.Value || tags.StudyDescription;
        tags.StudyDate = rawTags["0008,0020"]?.Value || tags.StudyDate;
        tags.StudyTime = rawTags["0008,0030"]?.Value || tags.StudyTime;
        tags.AccessionNumber = rawTags["0008,0050"]?.Value || tags.AccessionNumber;
        tags.InstitutionName = rawTags["0008,0080"]?.Value || tags.InstitutionName;
        tags.ReferringPhysicianName = rawTags["0008,0090"]?.Value || tags.ReferringPhysicianName;
        
        // 🔧 CRITICAL: Extract private tags for lab identification (EXACTLY AS YOUR CODE)
        tags["0013,0010"] = rawTags["0013,0010"]?.Value || null;
        tags["0015,0010"] = rawTags["0015,0010"]?.Value || null;
        tags["0021,0010"] = rawTags["0021,0010"]?.Value || null;
        tags["0043,0010"] = rawTags["0043,0010"]?.Value || null;
        
        console.log(`[StableStudy] ✅ Got tags from single instance:`, {
          PatientName: tags.PatientName,
          PatientID: tags.PatientID,
          StudyDescription: tags.StudyDescription,
          PrivateTags: {
            "0013,0010": tags["0013,0010"],
            "0015,0010": tags["0015,0010"], 
            "0021,0010": tags["0021,0010"],
            "0043,0010": tags["0043,0010"]
          }
        });
        
      } catch (metadataError) {
        console.warn(`[StableStudy] ⚠️ Could not get instance metadata:`, metadataError.message);
        
        // 🔧 FALLBACK: Try simplified-tags if /tags fails (EXACTLY AS YOUR CODE)
        try {
          const simplifiedUrl = `${ORTHANC_BASE_URL}/instances/${firstInstanceId}/simplified-tags`;
          const simplifiedResponse = await axios.get(simplifiedUrl, {
            headers: { 'Authorization': orthancAuth },
            timeout: 8000
          });
          
          tags = { ...simplifiedResponse.data };
          console.log(`[StableStudy] ✅ Got simplified metadata as fallback`);
        } catch (simplifiedError) {
          console.warn(`[StableStudy] ⚠️ Simplified tags also failed:`, simplifiedError.message);
        }
      }
    }
    
    // Fallback for empty modalities (EXACTLY AS YOUR CODE)
    if (modalitiesSet.size === 0) {
      modalitiesSet.add('UNKNOWN');
    }
    
    job.progress = 70;
    
    // Continue with patient and lab creation (EXACTLY AS YOUR CODE)
    const patientRecord = await findOrCreatePatientFromTags(tags);
    const labRecord = await findOrCreateSourceLab(tags);
    
    console.log(`[StableStudy] 👤 Patient: ${patientRecord.patientNameRaw}`);
    console.log(`[StableStudy] 🏥 Lab: ${labRecord.name}`);
    
    job.progress = 80;
    
    // 🔧 UPDATED: Find existing study by orthancStudyID (EXACTLY AS YOUR CODE)
    let dicomStudyDoc = await DicomStudy.findOne({ orthancStudyID: orthancStudyId });
    
    console.log(`[StableStudy] 📊 Final optimized counts - Series: ${allSeries.length}, Instances: ${totalInstances}`);
    
    const studyData = {
      orthancStudyID: orthancStudyId,
      accessionNumber: tags.AccessionNumber || '',
      patient: patientRecord._id,
      patientId: patientRecord.patientID,
      sourceLab: labRecord._id,
      studyDate: formatDicomDateToISO(tags.StudyDate),
      studyTime: tags.StudyTime || '',
      modalitiesInStudy: Array.from(modalitiesSet),
      examDescription: tags.StudyDescription || 'Unknown Study',
      institutionName: tags.InstitutionName || '',
      workflowStatus: totalInstances > 0 ? 'new_study_received' : 'new_metadata_only',
      
      // 🔧 OPTIMIZED: Use calculated counts (EXACTLY AS YOUR CODE)
      seriesCount: allSeries.length,
      instanceCount: totalInstances,
      seriesImages: `${allSeries.length}/${totalInstances}`,
      
      patientInfo: {
        patientID: patientRecord.patientID,
        patientName: patientRecord.patientNameRaw,
        gender: patientRecord.gender || '',
        dateOfBirth: tags.PatientBirthDate || ''
      },
      
      referringPhysicianName: tags.ReferringPhysicianName || '',
      physicians: {
        referring: {
          name: tags.ReferringPhysicianName || '',
          email: '',
          mobile: tags.ReferringPhysicianTelephoneNumbers || '',
          institution: tags.ReferringPhysicianAddress || ''
        },
        requesting: {
          name: tags.RequestingPhysician || '',
          email: '',
          mobile: '',
          institution: tags.RequestingService || ''
        }
      },
      
      technologist: {
        name: tags.OperatorName || tags.PerformingPhysicianName || '',
        mobile: '',
        comments: '',
        reasonToSend: tags.ReasonForStudy || tags.RequestedProcedureDescription || ''
      },
      
      studyPriority: tags.StudyPriorityID || 'SELECT',
      caseType: tags.RequestPriority || 'routine',
      
      equipment: {
        manufacturer: tags.Manufacturer || '',
        model: tags.ManufacturerModelName || '',
        stationName: tags.StationName || '',
        softwareVersion: tags.SoftwareVersions || ''
      },
      
      protocolName: tags.ProtocolName || '',
      bodyPartExamined: tags.BodyPartExamined || '',
      contrastBolusAgent: tags.ContrastBolusAgent || '',
      contrastBolusRoute: tags.ContrastBolusRoute || '',
      acquisitionDate: tags.AcquisitionDate || '',
      acquisitionTime: tags.AcquisitionTime || '',
      studyComments: tags.StudyComments || '',
      additionalPatientHistory: tags.AdditionalPatientHistory || '',
      
      // Store lab identification info (EXACTLY AS YOUR CODE)
      customLabInfo: {
        dicomLabId: tags["0011,1010"] || null,
        labIdSource: tags["0011,1010"] ? 'dicom_custom_tag' : 'private_tags_detection',
        labDetectionMethod: 'private_tags_lookup'
      },
      
      storageInfo: {
        type: 'orthanc',
        orthancStudyId: orthancStudyId,
        receivedAt: new Date(),
        isStableStudy: true,
        instancesFound: totalInstances,
        processingMethod: totalInstances > 0 ? 'optimized_with_instances' : 'metadata_only',
        debugInfo: {
          apiCallsUsed: 2, // Only /series and /tags calls
          seriesApiUsed: true,
          singleInstanceTagsUsed: true,
          modalitiesExtracted: Array.from(modalitiesSet),
          customLabIdProvided: !!(tags["0013,0010"] || tags["0015,0010"] || tags["0021,0010"] || tags["0043,0010"]),
          privateTagsFound: {
            "0013,0010": tags["0013,0010"] || null,
            "0015,0010": tags["0015,0010"] || null,
            "0021,0010": tags["0021,0010"] || null,
            "0043,0010": tags["0043,0010"] || null
          }
        }
      }
    };
    
    if (dicomStudyDoc) {
      console.log(`[StableStudy] 📝 Updating existing study`);
      Object.assign(dicomStudyDoc, studyData);
      dicomStudyDoc.statusHistory.push({
        status: studyData.workflowStatus,
        changedAt: new Date(),
        note: `Optimized stable study updated: ${allSeries.length} series, ${totalInstances} instances. Lab: ${labRecord.name}`
      });
    } else {
      console.log(`[StableStudy] 🆕 Creating new study`);
      dicomStudyDoc = new DicomStudy({
        ...studyData,
        statusHistory: [{
          status: studyData.workflowStatus,
          changedAt: new Date(),
          note: `Optimized stable study created: ${allSeries.length} series, ${totalInstances} instances. Lab: ${labRecord.name}`
        }]
      });
    }
    
    await dicomStudyDoc.save();
    console.log(`[StableStudy] ✅ Study saved with ID: ${dicomStudyDoc._id}`);
    
    // 🆕 ADDITION: Queue ZIP creation job if study has instances
    if (totalInstances > 0) {
        console.log(`[StableStudy] 📦 Queuing ZIP creation for study: ${orthancStudyId}`);
        
        try {
            const zipJob = await CloudflareR2ZipService.addZipJob({
                orthancStudyId: orthancStudyId,
                studyDatabaseId: dicomStudyDoc._id,
                studyInstanceUID: dicomStudyDoc.studyInstanceUID || orthancStudyId, // Use orthancStudyId as fallback
                instanceCount: totalInstances,
                seriesCount: allSeries.length
            });
            
            console.log(`[StableStudy] 📦 ZIP Job ${zipJob.id} queued for study: ${orthancStudyId}`);
        } catch (zipError) {
            console.error(`[StableStudy] ❌ Failed to queue ZIP job:`, zipError.message);
            // Don't fail the study processing if ZIP queueing fails
        }
    } else {
        console.log(`[StableStudy] ⚠️ Skipping ZIP creation - no instances found`);
    }
    
    job.progress = 90;
    
    // Send notification (EXACTLY AS YOUR CODE)
    try {
      await websocketService.notifySimpleNewStudy();
      console.log(`[StableStudy] ✅ Notification sent`);
    } catch (wsError) {
      console.warn(`[StableStudy] ⚠️ Notification failed:`, wsError.message);
    }
    
    job.progress = 100;
    
    const result = {
      success: true,
      orthancStudyId: orthancStudyId,
      studyDatabaseId: dicomStudyDoc._id,
      seriesCount: allSeries.length,
      instanceCount: totalInstances,
      processedAt: new Date(),
      elapsedTime: Date.now() - startTime,
      processingMethod: 'optimized_api_calls',
      apiCallsUsed: 2, // Only /series and /tags calls
      metadataSummary: {
        patientName: patientRecord.patientNameRaw,
        patientId: patientRecord.patientID,
        modalities: Array.from(modalitiesSet),
        studyDate: tags.StudyDate || 'Unknown',
        labName: labRecord.name,
        institutionName: tags.InstitutionName || 'Unknown'
      }
    };
    
    await redis.setex(`job:result:${requestId}`, 3600, JSON.stringify(result));
    
    console.log(`[StableStudy] ✅ Optimized processing completed in ${Date.now() - startTime}ms - Series: ${allSeries.length}, Instances: ${totalInstances}`);
    return result;
    
  } catch (error) {
    const elapsedTime = Date.now() - startTime;
    console.error(`[StableStudy] ❌ Failed after ${elapsedTime}ms:`, error.message);
    
    const errorResult = {
      success: false,
      error: error.message,
      elapsedTime: elapsedTime,
      orthancStudyId: orthancStudyId,
      failedAt: new Date()
    };
    
    await redis.setex(`job:result:${requestId}`, 3600, JSON.stringify(errorResult));
    throw error;
  }
}

// --- Redis Connection Setup ---
redis.on('connect', () => {
  console.log('✅ Redis connected successfully');
});

redis.on('ready', () => {
  console.log('✅ Redis is ready for operations');
});

redis.on('error', (error) => {
  console.error('❌ Redis connection error:', error.message);
});

// Test Redis connection
console.log('🧪 Testing Redis connection...');
redis.ping()
  .then(() => {
    console.log('✅ Redis ping successful');
    return redis.set('startup-test', 'stable-study-system');
  })
  .then(() => {
    console.log('✅ Redis write test successful');
    return redis.get('startup-test');
  })
  .then((value) => {
    console.log('✅ Redis read test successful, value:', value);
    return redis.del('startup-test');
  })
  .then(() => {
    console.log('✅ All Redis tests passed');
  })
  .catch(error => {
    console.error('❌ Redis test failed:', error.message);
  });

// --- Routes ---

// Test connection route
router.get('/test-connection', async (req, res) => {
  try {
    // Test Redis
    await redis.set('test-key', `test-${Date.now()}`);
    const redisResult = await redis.get('test-key');
    await redis.del('test-key');
    
    // Test Orthanc
    const orthancResponse = await axios.get(`${ORTHANC_BASE_URL}/system`, {
      headers: { 'Authorization': orthancAuth },
      timeout: 5000
    });
    
    res.json({
      redis: 'working',
      redisValue: redisResult,
      orthanc: 'working',
      orthancVersion: orthancResponse.data.Version,
      queue: 'working',
      timestamp: new Date().toISOString()
    });
    
  } catch (error) {
    console.error('Connection test failed:', error);
    res.status(500).json({
      error: error.message
    });
  }
});

// Main stable study route
router.post('/stable-study', async (req, res) => {
  console.log('[StableStudy] 📋 Received stable study notification');
  console.log('[StableStudy] 📋 Body type:', typeof req.body);
  console.log('[StableStudy] 📋 Body content:', req.body);
  
  let orthancStudyId = null; 
  try {
    // Extract Orthanc study ID from request
    if (typeof req.body === 'string') {
      orthancStudyId = req.body.trim();
      console.log('[StableStudy] 📋 Extracted from string:', orthancStudyId);
    } else if (req.body && typeof req.body === 'object') {
      // Handle the case where body is an object like { '9442d79e-...': '' }
      const keys = Object.keys(req.body);
      if (keys.length > 0) {
        orthancStudyId = keys[0]; // Take the first key as the study ID
        console.log('[StableStudy] 📋 Extracted from object key:', orthancStudyId);
      } else if (req.body.studyId) {
        orthancStudyId = req.body.studyId;
        console.log('[StableStudy] 📋 Extracted from studyId field:', orthancStudyId);
      } else if (req.body.ID) {
        orthancStudyId = req.body.ID;
        console.log('[StableStudy] 📋 Extracted from ID field:', orthancStudyId);
      }
    }
    
    console.log('[StableStudy] 📋 Final extracted ID:', orthancStudyId);
    
    if (!orthancStudyId || orthancStudyId.trim() === '') {
      console.error('[StableStudy] ❌ No valid Orthanc Study ID found');
      return res.status(400).json({ 
        error: 'Invalid or missing Orthanc Study ID',
        receivedBody: req.body,
        bodyType: typeof req.body,
        keys: typeof req.body === 'object' ? Object.keys(req.body) : 'N/A'
      });
    }
    
    // Clean the study ID
    orthancStudyId = orthancStudyId.trim();
    console.log('[StableStudy] 📋 Using study ID:', orthancStudyId);
    
    const requestId = `stable_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
    console.log('[StableStudy] 📋 Generated request ID:', requestId);
    
    // Add job to process the complete stable study
    const job = await jobQueue.add({
      orthancStudyId: orthancStudyId,
      requestId: requestId,
      submittedAt: new Date(),
      originalBody: req.body
    });
    
    console.log(`[StableStudy] ✅ Job ${job.id} queued for stable study: ${orthancStudyId}`);
    
    // Immediate response
    res.status(202).json({
      message: 'Stable study queued for processing',
      jobId: job.id,
      requestId: requestId,
      orthancStudyId: orthancStudyId,
      status: 'queued',
      checkStatusUrl: `/orthanc/job-status/${requestId}`
    });
    
  } catch (error) {
    console.error('[StableStudy] ❌ Error in route handler:', error);
    console.error('[StableStudy] ❌ Error stack:', error.stack);
    res.status(500).json({
      message: 'Error queuing stable study for processing',
      error: error.message,
      receivedBody: req.body,
      stack: process.env.NODE_ENV === 'development' ? error.stack : undefined
    });
  }
});

// Job status route
router.get('/job-status/:requestId', async (req, res) => {
  const { requestId } = req.params;
  
  try {
    // Check Redis first
    const resultData = await redis.get(`job:result:${requestId}`);
    
    if (resultData) {
      const result = JSON.parse(resultData);
      res.json({
        status: result.success ? 'completed' : 'failed',
        result: result,
        requestId: requestId
      });
    } else {
      // Check in-memory queue
      const job = jobQueue.getJobByRequestId(requestId);
      
      if (job) {
        res.json({
          status: job.status,
          progress: job.progress,
          requestId: requestId,
          jobId: job.id,
          createdAt: job.createdAt,
          error: job.error
        });
      } else {
        res.status(404).json({
          status: 'not_found',
          message: 'Job not found or expired',
          requestId: requestId
        });
      }
    }
  } catch (error) {
    console.error('Error checking job status:', error);
    res.status(500).json({
      status: 'error',
      message: 'Error checking job status',
      error: error.message
    });
  }
});

// 🆕 NEW: Manual ZIP creation endpoint
router.post('/create-zip/:orthancStudyId', async (req, res) => {
    try {
        const { orthancStudyId } = req.params;
        
        console.log(`[Manual ZIP] 📦 Manual ZIP creation requested for: ${orthancStudyId}`);
        
        // Find study in database
        const study = await DicomStudy.findOne({ orthancStudyID: orthancStudyId });
        
        if (!study) {
            return res.status(404).json({
                success: false,
                message: 'Study not found in database'
            });
        }
        
        // Check if ZIP is already being processed or completed
        if (study.preProcessedDownload?.zipStatus === 'processing') {
            return res.json({
                success: false,
                message: 'ZIP creation already in progress',
                status: 'processing',
                jobId: study.preProcessedDownload.zipJobId
            });
        }
        
        if (study.preProcessedDownload?.zipStatus === 'completed' && study.preProcessedDownload?.zipUrl) {
            return res.json({
                success: true,
                message: 'ZIP already exists',
                status: 'completed',
                zipUrl: study.preProcessedDownload.zipUrl,
                zipSizeMB: study.preProcessedDownload.zipSizeMB,
                createdAt: study.preProcessedDownload.zipCreatedAt
            });
        }
        
        // Queue new ZIP creation job
        const zipJob = await CloudflareR2ZipService.addZipJob({
            orthancStudyId: orthancStudyId,
            studyDatabaseId: study._id,
            studyInstanceUID: study.studyInstanceUID || orthancStudyId,
            instanceCount: study.instanceCount || 0,
            seriesCount: study.seriesCount || 0
        });
        
        res.json({
            success: true,
            message: 'ZIP creation queued',
            jobId: zipJob.id,
            status: 'queued',
            checkStatusUrl: `/orthanc/zip-status/${zipJob.id}`
        });
        
    } catch (error) {
        console.error('[Manual ZIP] ❌ Error:', error);
        res.status(500).json({
            success: false,
            message: 'Failed to queue ZIP creation',
            error: error.message
        });
    }
});

// 🆕 NEW: ZIP job status endpoint
router.get('/zip-status/:jobId', async (req, res) => {
    try {
        const { jobId } = req.params;
        const job = CloudflareR2ZipService.getJob(parseInt(jobId));
        
        if (!job) {
            return res.status(404).json({
                success: false,
                message: 'ZIP job not found'
            });
        }
        
        res.json({
            success: true,
            jobId: job.id,
            status: job.status,
            progress: job.progress,
            createdAt: job.createdAt,
            result: job.result,
            error: job.error
        });
        
    } catch (error) {
        console.error('[ZIP Status] ❌ Error:', error);
        res.status(500).json({
            success: false,
            message: 'Failed to get ZIP status',
            error: error.message
        });
    }
});

// 🆕 NEW: Initialize R2 bucket on startup
router.get('/init-r2', async (req, res) => {
    try {
        await CloudflareR2ZipService.ensureR2Bucket();
        res.json({
            success: true,
            message: 'R2 bucket initialized successfully'
        });
    } catch (error) {
        console.error('[R2 Init] ❌ Error:', error);
        res.status(500).json({
            success: false,
            message: 'Failed to initialize R2 bucket',
            error: error.message
        });
    }
});

export default router;