import assert from 'node:assert/strict';
import test from 'node:test';
import { mediaSaveMode, SIMPLE_ZIP_BYTES } from '../lib/media-save.js';
import { MAX_ZIP_BYTES } from '../lib/media-backup.js';

test('default JSON/avatar ZIP never requests a directory, even when Chrome offers a folder picker',()=>{
  for(const size of [0,19*1024*1024,SIMPLE_ZIP_BYTES]) assert.equal(mediaSaveMode(size,{filePicker:true,folderPicker:true}),'download');
});
test('larger single ZIP streams to an individual file instead of opening protected Downloads folder',()=>{
  for(const size of [SIMPLE_ZIP_BYTES+1,300*1024*1024,MAX_ZIP_BYTES-1]) assert.equal(mediaSaveMode(size,{filePicker:true,folderPicker:true}),'file');
});
test('very large streaming packages preserve existing multipart route; unsupported sizes fail closed',()=>{
  assert.equal(mediaSaveMode(MAX_ZIP_BYTES,{filePicker:true,folderPicker:true}),'directory');
  assert.equal(mediaSaveMode(MAX_ZIP_BYTES,{filePicker:true}),'unavailable');
  assert.equal(mediaSaveMode(SIMPLE_ZIP_BYTES+1,{folderPicker:true}),'directory');
  for(const value of [-1,NaN,Infinity]) assert.equal(mediaSaveMode(value,{filePicker:true,folderPicker:true}),'unavailable');
});
