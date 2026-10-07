/* AUTO-ADAPTIVE WHITE TEXT REMOVAL
   Paste as a SECOND <script> block, right after your existing </script>.
   It overrides: buildStaticMask() and patchWithMask().
   Everything is measured from the box you draw, so there are no per-video constants:
   - stroke thickness   -> estimated from the box size (works at any resolution)
   - detection threshold-> Otsu on local contrast (top-hat), works for dim or bright text
   - brightness floor   -> relative to the median brightness inside the box
   - safety cap         -> if "text" covers too much of the box, threshold is raised automatically
   - fill               -> push-pull inpaint (always succeeds, no source search that can fail)
   The sensitivity slider is now only a fine-tune bias (200 = neutral). */

function otsuFrom(hist,from){
  let total=0,sum=0;
  for(let i=from;i<256;i++){total+=hist[i];sum+=i*hist[i];}
  if(total<10)return -1;
  let wB=0,sB=0,best=-1,bestVar=-1;
  for(let t=from;t<256;t++){
    wB+=hist[t];sB+=t*hist[t];
    const wF=total-wB;
    if(!wB||!wF)continue;
    const mB=sB/wB,mF=(sum-sB)/wF,v=wB*wF*(mB-mF)*(mB-mF);
    if(v>bestVar){bestVar=v;best=t;}
  }
  return best;
}

function autoMask(d,w,h,x0,y0,x1,y1){
  x0=Math.max(0,Math.floor(x0));y0=Math.max(0,Math.floor(y0));
  x1=Math.min(w,Math.ceil(x1));y1=Math.min(h,Math.ceil(y1));
  const bw=x1-x0,bh=y1-y0;
  if(bw<4||bh<4)return null;
  const N=w*h,lum=new Float32Array(N);
  for(let p=0;p<N;p++){const i=p*4;lum[p]=d[i]*.299+d[i+1]*.587+d[i+2]*.114;}

  // stroke size estimated from the box itself
  const r=clamp(Math.round(Math.min(bw,bh)*0.07)+1,2,14);
  const opened=sepFilter(sepFilter(lum,w,h,r,false),w,h,r,true);

  // statistics inside the box
  const lh=new Uint32Array(256),th=new Uint32Array(256);
  for(let y=y0;y<y1;y++)for(let x=x0;x<x1;x++){
    const p=y*w+x;
    lh[Math.min(255,Math.round(lum[p]))]++;
    th[clamp(Math.round(lum[p]-opened[p]),0,255)]++;
  }
  let acc=0,median=128;
  for(let i=0;i<256;i++){acc+=lh[i];if(acc>=bw*bh/2){median=i;break;}}
  const otsu=otsuFrom(th,3);
  if(otsu<0)return null;
  const bias=Math.pow((+$('whiteThreshold').value||200)/200,1.5);
  let T=Math.max(18,otsu*0.85)*bias;
  const Lmin=Math.max(90,median+22);
  const area=bw*bh;

  let mask=null,cnt=0;
  for(let k=0;k<6;k++){
    mask=new Uint8Array(N);cnt=0;
    for(let y=y0;y<y1;y++)for(let x=x0;x<x1;x++){
      const p=y*w+x,i=p*4,L=lum[p];
      if(L<Lmin)continue;
      const mx=Math.max(d[i],d[i+1],d[i+2]),mn=Math.min(d[i],d[i+1],d[i+2]);
      if(mx-mn>95)continue;
      if(L-opened[p]>=T){mask[p]=1;cnt++;}
    }
    if(cnt/area<=0.12)break;
    T*=1.25;
  }
  if(!cnt||cnt/area>0.12)return null;   // looks like scenery, not text: leave untouched

  // anti-aliased edge pixels next to strong stroke pixels
  const near=dilateMask(mask,w,h,2);
  for(let y=y0;y<y1;y++)for(let x=x0;x<x1;x++){
    const p=y*w+x;
    if(!mask[p]&&near[p]&&lum[p]>=Lmin-20&&lum[p]-opened[p]>=T*0.4)mask[p]=1;
  }
  return mask;
}

async function buildStaticMask(){
  while(staticBuilding){try{await staticBuilding}catch(e){}}
  const boxes=[whiteRect,...extraRects].filter(Boolean);
  if(!boxes.length||!duration)return null;
  const key=wrKey();
  if(staticMask&&staticMask.key===key)return staticMask;
  const job=(async()=>{
    const r={...sourceRect()};
    const s0=clamp(+$('trimStart').value||0,0,duration);
    const e0=clamp(+$('trimEnd').value||duration,s0+.05,duration);
    const n=Math.min(18,Math.max(10,Math.ceil((e0-s0)/1.2)));
    const results=[],saved=video.currentTime;
    video.pause();
    for(const wr of boxes){
      const rw=Math.max(4,Math.round(wr.w)),rh=Math.max(4,Math.round(wr.h));
      const sc=Math.min(1,1200/Math.max(rw,rh));
      const aw=Math.max(4,Math.round(rw*sc)),ah=Math.max(4,Math.round(rh*sc));
      const count=new Uint16Array(aw*ah);
      const cv=document.createElement('canvas');cv.width=aw;cv.height=ah;
      const cx=cv.getContext('2d',{willReadFrequently:true});
      for(let i=0;i<n;i++){
        await seekVideo(s0+(e0-s0)*(i+.5)/n);
        cx.drawImage(video,r.x+wr.x,r.y+wr.y,wr.w,wr.h,0,0,aw,ah);
        const id=cx.getImageData(0,0,aw,ah);
        const m=autoMask(id.data,aw,ah,0,0,aw,ah);
        if(m)for(let p=0;p<m.length;p++)if(m[p])count[p]++;
      }
      // overlay text stays in the same place; moving scenery does not
      const need=Math.max(2,Math.ceil(n*0.3));
      const out=document.createElement('canvas');out.width=aw;out.height=ah;
      const ox=out.getContext('2d'),oi=ox.createImageData(aw,ah);let any=false;
      for(let p=0;p<count.length;p++)if(count[p]>=need){
        const i=p*4;oi.data[i]=oi.data[i+1]=oi.data[i+2]=255;oi.data[i+3]=255;any=true;
      }
      ox.putImageData(oi,0,0);
      results.push({canvas:out,any,sc:{},box:{...wr}});   // sc must be an object cache
    }
    await seekVideo(saved);
    staticMasks=results;
    staticMask={key,masks:results,any:results.some(x=>x.any)};
  })();
  staticBuilding=job;
  try{await job}finally{staticBuilding=null}
  return staticMask;
}

function patchWithMask(ctx2,W,H,rect,maskOverride){
  if(!rect)return;
  const rx0=Math.max(0,Math.floor(rect.x)),ry0=Math.max(0,Math.floor(rect.y));
  const rx1=Math.min(W,Math.ceil(rect.x+rect.w)),ry1=Math.min(H,Math.ceil(rect.y+rect.h));
  const rw=rx1-rx0,rh=ry1-ry0;
  if(rw<4||rh<4)return;

  const pad=clamp(Math.round(Math.max(rw,rh)*0.25),16,60);
  const x0=Math.max(0,rx0-pad),y0=Math.max(0,ry0-pad),x1=Math.min(W,rx1+pad),y1=Math.min(H,ry1+pad);
  const w=x1-x0,h=y1-y0,N=w*h;
  const img=ctx2.getImageData(x0,y0,w,h),d=img.data;
  const bx0=rx0-x0,by0=ry0-y0,bx1=rx1-x0,by1=ry1-y0;

  let hole=new Uint8Array(N),any=false;
  const dyn=autoMask(d,w,h,bx0,by0,bx1,by1);
  if(dyn)for(let y=by0;y<by1;y++)for(let x=bx0;x<bx1;x++)if(dyn[y*w+x]){hole[y*w+x]=1;any=true;}
  if(maskOverride&&maskOverride.any){
    const sm=scaledStatic(maskOverride,rw,rh);
    for(let y=0;y<rh;y++)for(let x=0;x<rw;x++)if(sm[y*rw+x]){hole[(y+by0)*w+(x+bx0)]=1;any=true;}
  }
  if(!any)return;

  // grow to swallow halo / compression ringing; size follows the text size
  const r=clamp(Math.round(Math.min(rw,rh)*0.07)+1,2,14);
  const grow=clamp(Math.round(r*0.6)+1,1,6);
  hole=dilateMask(hole,w,h,grow);
  for(let y=0;y<h;y++)for(let x=0;x<w;x++)
    if(x<bx0||x>=bx1||y<by0||y>=by1)hole[y*w+x]=0;

  if($('showMask').checked&&!exporting){
    let c=0;
    for(let p=0;p<N;p++)if(hole[p]){const i=p*4;d[i]=255;d[i+1]=0;d[i+2]=60;c++;}
    ctx2.putImageData(img,x0,y0);
    setStatus('Detected text pixels: '+(c/(rw*rh)*100).toFixed(2)+'% of the box (red = will be removed).');
    return;
  }
  const strength=clamp((+$('removeOpacity').value||100)/100,0,1);
  inpaintHole(d,w,h,hole,strength);
  ctx2.putImageData(img,x0,y0);
}
