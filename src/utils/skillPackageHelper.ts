import * as vscode from 'vscode';
import * as fs from 'fs-extra';
import * as path from 'path';
import { Options } from 'async-retry';
import { HttpClient } from 'typed-rest-client/HttpClient';
import { 
    SmapiResource, SmapiClientFactory, Utils
} from '../runtime';
import * as model from 'ask-smapi-model';

import retry = require('async-retry'); 
import ExportResponse = model.v1.skill.ExportResponse;

import { SkillInfo } from '../models/types';
import { SKILL_FOLDER, SKILL, DEFAULT_PROFILE } from '../constants';
import { unzipFile } from './zipHelper';
import { loggableAskError } from '../exceptions';
import { Logger } from '../logger';

export async function downloadSkillPackage(
    remoteLocation: string, destFolder: string, overWrite?: boolean): Promise<string> {
    Logger.verbose(`Calling method: downloadSkillPackage, args:`, remoteLocation, destFolder, overWrite);
    try {
        overWrite = (overWrite === undefined) ? true : false;
        const client = new HttpClient("askToolkit");
        const response = await client.get(remoteLocation);
        const destPath = path.join(destFolder, 'skillPackage.zip');
        
        if (fs.existsSync(destPath)) {
            if (overWrite) {
                fs.unlinkSync(destPath);
            } else {
                throw loggableAskError(`${destPath} already exists!!`);
            }
        }
    
        const skillPkgZipFile: NodeJS.WritableStream = fs.createWriteStream(destPath);
    
        if (response.message.statusCode !== 200) {
            throw loggableAskError(`HTTP request failure ${response.message}`);
        }
        
        // eslint-disable-next-line no-undef
        return new Promise((resolve, reject) => {
            skillPkgZipFile.on("error", (err) => reject(err));
            const stream = response.message.pipe(skillPkgZipFile);
            stream.on("close", () => {
                try { 
                    resolve(destPath); 
                } catch (err) {
                    reject(err);
                }
            });
        });
    } catch (err) {
        throw loggableAskError(`Skill package download failed.`, err);
    }
}

export function createSkillPackageFolder(skillFolder: string): void {
    Logger.verbose(`Calling method: createSkillPackageFolder, args:`, skillFolder);
    try {
        const skillPkgFolderPath = path.join(skillFolder, SKILL_FOLDER.SKILL_PACKAGE.NAME);
        
        if (!fs.existsSync(skillPkgFolderPath)) {
            fs.mkdirSync(skillPkgFolderPath);
        }
    
        const modelsPath = path.join(skillFolder, SKILL_FOLDER.MODELS);
        const skillJsonPath = path.join(skillFolder, SKILL_FOLDER.SKILL_MANIFEST);
        const ispsPath = path.join(skillFolder, SKILL_FOLDER.ISPS);
        const doModelsExist = fs.existsSync(modelsPath);
        const doSkillJsonExist = fs.existsSync(skillJsonPath);
        const doIspsExist = fs.existsSync(ispsPath);
        if (doModelsExist) {
            fs.moveSync(modelsPath, path.join(skillFolder, SKILL_FOLDER.SKILL_PACKAGE.CUSTOM_MODELS));
        }
        if (doSkillJsonExist) {
            fs.moveSync(skillJsonPath, path.join(skillFolder, SKILL_FOLDER.SKILL_PACKAGE.MANIFEST));
        }
        if (doIspsExist) {
            fs.moveSync(skillJsonPath, path.join(skillFolder, SKILL_FOLDER.SKILL_PACKAGE.ISPS));
        }
    } catch (err) {
        throw loggableAskError(`Create skill package folder failed`, err);
    }
}

async function pollExportStatus(
    exportId: string, context: vscode.ExtensionContext): Promise<ExportResponse> {
    Logger.verbose(`Calling method: pollExportStatus, args:`, exportId);
    
    // These numbers are taken from CLI.
    const retryOptions: Options = {
        retries: 30,
        minTimeout: 2000,
        factor: 1.1
    };

    let profile = Utils.getCachedProfile(context);
    profile = profile ?? DEFAULT_PROFILE;
    const smapiClient = SmapiClientFactory.getInstance(profile, context);

    const skillStatus = await retry(async (bail: (err: Error) => void, attempt: number): Promise<ExportResponse> => {
        const exportStatus = await smapiClient.getStatusOfExportRequestV1(exportId);
        
        // TODO: check the error when statusCode is not 200 or check the body strucutre when status is not SUCCEEDED or check non skill case

        if (exportStatus === SKILL.PACKAGE_STATUS.IN_PROGRESS) {
            throw loggableAskError('Skill package export in progress');
        }

        return exportStatus;
    }, retryOptions);

    return skillStatus;
}

export async function syncSkillPackage(
    skillPackageFolder: string, skillInfo: SmapiResource<SkillInfo>, 
    context: vscode.ExtensionContext): Promise<void> {
    Logger.verbose(`Calling method: syncSkillPackage, args:`, skillPackageFolder, skillInfo);
    try {
        const skillPkgRemoteLocation = await getSkillPkgRemoteLocation(context, skillInfo.data.skillSummary.skillId);
        const skillPkgZipLocation = await downloadSkillPackage(skillPkgRemoteLocation!, skillPackageFolder);
        unzipFile(skillPkgZipLocation, skillPackageFolder);
    } catch (err) {
        throw loggableAskError(`Sync skill package failed, with error:`, err);
    }
}

export async function getSkillPkgRemoteLocation(context: vscode.ExtensionContext, skillId: string | undefined) {
    try {
        let profile = Utils.getCachedProfile(context);
        profile = profile ?? DEFAULT_PROFILE;
        const smapiClient = SmapiClientFactory.getInstance(profile, context);
        const exportResponse = await smapiClient.callCreateExportRequestForSkillV1(
            skillId!, 'development');

        let exportId = exportResponse.headers.find(value => value.key === 'location')?.value;
        // Get the exact exportId from the Url
        exportId = exportId?.substring(exportId?.lastIndexOf('/') + 1);
        
        const exportStatus = await pollExportStatus(exportId!, context);
        return exportStatus?.skill?.location;
    } catch (err) {
        throw loggableAskError(`Get skill package remote location failed, with error:`, err);
    }
}

export async function getSkillPkgZipLocation(
    skillPackageFolder: string, skillId: string, 
    context: vscode.ExtensionContext): Promise<string> {
    try {
        const skillPkgRemoteLocation = await getSkillPkgRemoteLocation(context, skillId);
        return await downloadSkillPackage(skillPkgRemoteLocation!, skillPackageFolder);
    } catch (err) {
        throw loggableAskError(`Download skill package failed, with error:`, err);
    }
}

