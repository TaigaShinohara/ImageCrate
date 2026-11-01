import test from 'node:test';
import assert from 'node:assert/strict';
import {deflateSync} from 'node:zlib';
import {tagPrivacyMetadata,readPrivacyMetadata,syntheticExif,SYNTHETIC_METADATA} from './helpers/privacy-metadata.mjs';
import {inspectImageMetadata} from '../extension/image-metadata.js';

const ascii=value=>new TextEncoder().encode(value);
const concat=(...parts)=>Uint8Array.from(parts.flatMap(part=>[...part]));
const be32=value=>[value>>>24,value>>>16,value>>>8,value];
const le32=value=>[value,value>>>8,value>>>16,value>>>24];
function chunk(type,body) {
  const data=concat(ascii(type),body);let crc=0xffffffff;
  for(const byte of data){crc^=byte;for(let bit=0;bit<8;bit++)crc=(crc>>>1)^((crc&1)?0xedb88320:0);}
  return concat(be32(body.length),data,be32((crc^0xffffffff)>>>0));
}
const png=concat([137,80,78,71,13,10,26,10],chunk('IHDR',concat(be32(16),be32(12),[8,6,0,0,0])),
  chunk('IDAT',deflateSync(new Uint8Array(12*(16*4+1)))),chunk('IEND',[]));
// Header-only raster payloads suffice for structural unit checks. Browser
// acceptance adds the same metadata to real canvas JPEG/WebP encodings.
const jpg=Uint8Array.from([255,216,255,192,0,11,8,0,12,0,16,1,1,0x11,0,255,218,0,8,1,1,0,0,63,0,1,255,217]);
const webpBody=concat(ascii('WEBP'),ascii('VP8L'),le32(5),[0x2f],le32(15|(11<<14)|0x10000000),[0]);
const webp=concat(ascii('RIFF'),le32(webpBody.length),webpBody);

test('privacy fixtures contain valid typed EXIF Artist/GPS/orientation and container-specific fields',()=>{
  for(const [format,source] of Object.entries({png,jpg,webp})) {
    const tagged=tagPrivacyMetadata(source,format),result=readPrivacyMetadata(tagged,format);
    const metadata=inspectImageMetadata(tagged);
    assert.deepEqual([metadata.width,metadata.height,metadata.orientation],[16,12,1]);
    assert.deepEqual(result.exif,[{orientation:1,artist:SYNTHETIC_METADATA.artist,gps:{latitudeRef:'N',latitude:[0,0,0],longitudeRef:'E',longitude:[0,0,0]}}]);
    if(format==='png')assert.deepEqual(result.text,[{keyword:SYNTHETIC_METADATA.keyword,value:SYNTHETIC_METADATA.marker}]);
    else assert.deepEqual(result.xmp,[{creators:[SYNTHETIC_METADATA.artist],descriptions:[SYNTHETIC_METADATA.marker]}]);
    if(format==='jpg')assert.deepEqual(result.iptc,[{record:2,dataset:80,value:SYNTHETIC_METADATA.artist},{record:2,dataset:120,value:SYNTHETIC_METADATA.marker}]);
  }
});

test('clockwise EXIF fixture reports oriented dimensions independently of encoded raster size',()=>{
  const tagged=tagPrivacyMetadata(jpg,'jpg',{orientation:6}),result=inspectImageMetadata(tagged);
  assert.deepEqual([result.encodedWidth,result.encodedHeight,result.width,result.height,result.orientation],[16,12,12,16,6]);
  assert.equal(readPrivacyMetadata(tagged,'jpg').exif[0].orientation,6);
  assert.throws(()=>syntheticExif(9),/orientation/);
});

test('metadata assertions parse typed structures instead of treating arbitrary marker bytes as a field',()=>{
  const marker=ascii(SYNTHETIC_METADATA.marker),length=marker.length+2;
  const jpegWithUnrelatedApp15=concat(jpg.slice(0,2),[255,239,length>>>8,length&255],marker,jpg.slice(2));
  assert.deepEqual(readPrivacyMetadata(jpegWithUnrelatedApp15,'jpg'),{exif:[],iptc:[],xmp:[],text:[]});
  const bad=tagPrivacyMetadata(png,'png');bad[40]^=1;
  assert.throws(()=>readPrivacyMetadata(bad,'png'),/CRC/);
  assert.throws(()=>readPrivacyMetadata(tagPrivacyMetadata(jpg,'jpg').slice(0,-2),'jpg'),/end/);
  assert.throws(()=>readPrivacyMetadata(tagPrivacyMetadata(webp,'webp').slice(0,-1),'webp'),/WebP/);
});
