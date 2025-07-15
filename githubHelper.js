const fs = require('fs');
const path = require('path');

// GitHub configuration
const GITHUB_TOKEN = process.env.GITHUB_TOKEN;
const REPO_OWNER = process.env.GITHUB_REPO_OWNER;
const REPO_NAME = process.env.GITHUB_REPO_NAME;
const BRANCH = 'main'; // or your default branch

let octokit;

async function initializeOctokit() {
  if (!octokit) {
    const { Octokit } = await import('@octokit/rest');
    octokit = new Octokit({
      auth: GITHUB_TOKEN
    });
  }
  return octokit;
}

async function updateFileOnGitHub(filePath, content, commitMessage) {
  try {
    const octokitInstance = await initializeOctokit();
    
    // Get the current SHA of the file
    let sha;
    try {
      const { data } = await octokitInstance.repos.getContent({
        owner: REPO_OWNER,
        repo: REPO_NAME,
        path: filePath,
        ref: BRANCH
      });
      sha = data.sha;
    } catch (error) {
      if (error.status === 404) {
        // File doesn't exist yet
        sha = null;
      } else {
        throw error;
      }
    }

    // Update the file
    await octokitInstance.repos.createOrUpdateFileContents({
      owner: REPO_OWNER,
      repo: REPO_NAME,
      path: filePath,
      message: commitMessage,
      content: Buffer.from(content).toString('base64'),
      sha: sha,
      branch: BRANCH
    });

    console.log(`Successfully updated ${filePath} on GitHub`);
    return true;
  } catch (error) {
    console.error(`Error updating ${filePath} on GitHub:`, error);
    throw error;
  }
}

module.exports = {
  updateFileOnGitHub
};