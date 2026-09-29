(() => {
  const keys = [
    [1,1,'sinh','sinh'],[1,2,'cosh','cosh'],[1,3,'tanh','tanh'],[1,4,'Exp','exp-marker'],[1,5,'(','('],[1,6,')',')'],[1,7,'←','back',2],[1,9,'C','clear'],[1,10,'+/−','sign'],[1,11,'√','sqrt'],
    [2,1,'sinh⁻¹','asinh'],[2,2,'cosh⁻¹','acosh'],[2,3,'tanh⁻¹','atanh'],[2,4,'log₂x','log2'],[2,5,'ln','ln'],[2,6,'log','log'],[2,7,'7','7'],[2,8,'8','8'],[2,9,'9','9'],[2,10,'/','/'],[2,11,'%','percent'],
    [3,1,'π','pi'],[3,2,'e','e'],[3,3,'n!','factorial'],[3,4,'logᵧx','logbase'],[3,5,'eˣ','exp'],[3,6,'10ˣ','pow10'],[3,7,'4','4'],[3,8,'5','5'],[3,9,'6','6'],[3,10,'*','*'],[3,11,'1/x','inverse'],
    [4,1,'sin','sin'],[4,2,'cos','cos'],[4,3,'tan','tan'],[4,4,'xʸ','^'],[4,5,'x³','cube'],[4,6,'x²','square'],[4,7,'1','1'],[4,8,'2','2'],[4,9,'3','3'],[4,10,'−','-'],[4,11,'=','equals',1,2],
    [5,1,'sin⁻¹','asin'],[5,2,'cos⁻¹','acos'],[5,3,'tan⁻¹','atan'],[5,4,'ʸ√x','root'],[5,5,'∛','cbrt'],[5,6,'|x|','abs'],[5,7,'0','0',2],[5,9,'.','.'],[5,10,'+','+']
  ];

  window.buildScientificCalculator = function () {
    state.expr='';state.memory=0;state.angle='deg';state.waitingForRight=null;
    const keypad=keys.map(([row,col,label,key,span=1,rowspan=1])=>`<button type="button" class="gate-calc-key ${['clear','back','sign','equals'].includes(key)?`key-${key}`:''} ${'0123456789.'.includes(key)&&key.length===1?'key-number':''}" data-sci="${key}" aria-label="${label}" style="grid-row:${row}${rowspan>1?` / span ${rowspan}`:''};grid-column:${col} / span ${span}">${label}</button>`).join('');
    return `<section class="tcs-calc-window" aria-label="Scientific Calculator">
      <header class="tcs-titlebar"><span>Scientific Calculator</span><button type="button" class="tcs-help" data-sci="help">Help</button><button type="button" class="tcs-minimize" data-sci="minimize" aria-label="Minimize">_</button><button type="button" class="tcs-close" data-dialog="close" aria-label="Close">×</button></header>
      <div class="tcs-calc-body"><input class="tcs-sequence" id="sciExpression" aria-label="Keypad input" readonly><input class="tcs-result" id="sciResult" aria-label="Result" value="0" readonly>
        <div class="gate-calc-controls"><button class="gate-calc-mod" data-sci="mod">mod</button><div class="gate-calc-angle" role="group" aria-label="Angle unit"><label><input type="radio" name="angleUnit" data-sci="deg" checked> Deg</label><label><input type="radio" name="angleUnit" data-sci="rad"> Rad</label></div><div class="gate-calc-memory" role="group" aria-label="Memory"><button data-sci="MC">MC</button><button data-sci="MR">MR</button><button data-sci="MS">MS</button><button data-sci="M+">M+</button><button data-sci="M-">M-</button></div></div>
        <div class="gate-calc-keypad">${keypad}</div><div class="tcs-help-panel" id="tcsHelpPanel" hidden>Use the mouse keypad to enter values and functions. Choose Deg or Rad before using trigonometric keys.</div>
      </div>
    </section>`;
  };

  const state = { expr:'', memory:0, angle:'deg', waitingForRight:null, ready:false };
  const supported = new Set(['sin','cos','tan','asin','acos','atan','sinh','cosh','tanh','asinh','acosh','atanh','ln','log','log2','sqrt','cbrt','abs','exp','pow10','inverse','fact','logbase','root']);
  function tokenize(source) {
    const s=source.replaceAll('×','*').replaceAll('÷','/').replaceAll('−','-').replaceAll('π','pi');
    const tokens=[];let i=0;
    while(i<s.length){if(/\s/.test(s[i])){i++;continue;}const rest=s.slice(i);const number=rest.match(/^(?:\d+\.?\d*|\.\d+)(?:[eE][+\-]?\d+)?/);if(number){tokens.push({type:'number',value:Number(number[0])});i+=number[0].length;continue;}const word=rest.match(/^[a-zA-Z]+/);if(word){tokens.push({type:'name',value:word[0].toLowerCase()});i+=word[0].length;continue;}if('+-*/^%!(),'.includes(s[i])){tokens.push({type:s[i]==='('? 'left':s[i]===')'?'right':s[i]===','?'comma':'op',value:s[i]});i++;continue;}throw Error('Unsupported character');}
    return tokens;
  }
  function evaluate(source) {
    const t=tokenize(source);let i=0;
    const peek=()=>t[i];const take=()=>t[i++];
    function expression(){let x=term();while(peek()?.value==='+'||peek()?.value==='-'){const op=take().value,y=term();x=op==='+'?x+y:x-y;}return x;}
    function term(){let x=unary();while(['*','/','%','mod'].includes(peek()?.value)){const op=take().value,y=unary();if((op==='/'||op==='mod')&&y===0)throw Error('Cannot divide by zero');x=op==='*'?x*y:op==='/'?x/y:x%y;}return x;}
    function unary(){if(peek()?.value==='+'){take();return unary();}if(peek()?.value==='-'){take();return -unary();}return power();}
    function power(){let x=postfix();if(peek()?.value==='^'){take();x=Math.pow(x,unary());}return x;}
    function postfix(){let x=primary();while(peek()?.value==='!'||peek()?.value==='%'){const op=take().value;if(op==='!')x=factorial(x);else x/=100;}return x;}
    function primary(){const token=take();if(!token)throw Error('Incomplete expression');if(token.type==='number')return token.value;if(token.type==='left'){const x=expression();if(peek()?.type!=='right')throw Error('Missing closing parenthesis');take();return x;}if(token.type==='name'){
      const name=token.value;if(name==='pi')return Math.PI;if(name==='e')return Math.E;
      if(!supported.has(name))throw Error('Unknown function');if(peek()?.type!=='left')throw Error('Function needs a value');take();const a=expression();let b;if(peek()?.type==='comma'){take();b=expression();}if(peek()?.type!=='right')throw Error('Missing closing parenthesis');take();return call(name,a,b);
    }throw Error('Incomplete expression');}
    const value=expression();if(i<t.length)throw Error('Check the expression');if(!Number.isFinite(value))throw Error('Math error');return value;
  }
  function factorial(n){if(n<0||!Number.isInteger(n)||n>170)throw Error('Factorial needs a whole number from 0 to 170');let r=1;for(let j=2;j<=n;j++)r*=j;return r;}
  function call(fn,x,y){const radians=state.angle==='deg'?x*Math.PI/180:x;let r;
    switch(fn){case'sin':r=Math.sin(radians);if(Math.abs(r)<1e-14)r=0;break;case'cos':r=Math.cos(radians);if(Math.abs(r)<1e-14)r=0;break;case'tan':if(Math.abs(Math.cos(radians))<1e-14)throw Error('Tangent is undefined at this angle');r=Math.tan(radians);break;case'asin':r=Math.asin(x);return state.angle==='deg'?r*180/Math.PI:r;case'acos':r=Math.acos(x);return state.angle==='deg'?r*180/Math.PI:r;case'atan':r=Math.atan(x);return state.angle==='deg'?r*180/Math.PI:r;
      case'sinh':r=Math.sinh(x);break;case'cosh':r=Math.cosh(x);break;case'tanh':r=Math.tanh(x);break;case'asinh':r=Math.asinh(x);break;case'acosh':r=Math.acosh(x);break;case'atanh':r=Math.atanh(x);break;case'ln':r=Math.log(x);break;case'log':r=Math.log10(x);break;case'log2':r=Math.log2(x);break;case'sqrt':r=Math.sqrt(x);break;case'cbrt':r=Math.cbrt(x);break;case'abs':r=Math.abs(x);break;case'exp':r=Math.exp(x);break;case'pow10':r=10**x;break;case'inverse':if(x===0)throw Error('Cannot divide by zero');r=1/x;break;case'fact':r=factorial(x);break;case'logbase':if(x<=0||y<=0||x===1)throw Error('Invalid logarithm base');r=Math.log(y)/Math.log(x);break;case'root':if(x===0||(y<0&&(!Number.isInteger(x)||Math.abs(x)%2!==1)))throw Error('Invalid root');r=y<0?-Math.pow(-y,1/x):Math.pow(y,1/x);break;default:throw Error('Unknown function');}
    if(!Number.isFinite(r))throw Error('Math error');return r;
  }
  function fmt(x){if(Object.is(x,-0))x=0;return Number(x.toPrecision(15)).toString();}
  function values(){return {expression:document.getElementById('sciExpression'),result:document.getElementById('sciResult'),hint:document.getElementById('sciHint')};}
  function write(node,value){if(!node)return;if('value'in node)node.value=value;else node.textContent=value;}
  function showHint(message){const {hint}=values();if(hint)hint.textContent=message;}
  function preview(){const {expression,result}=values();if(!expression||!result)return;write(expression,state.expr||'');try{write(result,fmt(evaluate(state.expr)));result.classList.remove('error');}catch(err){write(result,state.expr?'…':'0');result.classList.remove('error');}}
  function setExpr(expr){state.expr=expr;preview();}
  function closeParen(expr){let d=0;for(const c of expr){if(c==='(')d++;if(c===')')d--;}return expr+')'.repeat(Math.max(0,d));}
  function press(key){const {expression,result}=values();if(!result)return;
    if(key==='help'){document.getElementById('tcsHelpPanel')?.toggleAttribute('hidden');return;}
    if(key==='minimize'){document.getElementById('appDialog')?.classList.toggle('calculator-minimized');return;}
    if(key==='restore'){document.getElementById('appDialog')?.classList.remove('calculator-minimized');return;}
    if(key==='deg'||key==='rad'){state.angle=key;document.querySelectorAll('.gate-calc-angle input').forEach(b=>b.checked=b.dataset.sci===key);return;}
    if(key==='clear'){state.expr='';state.waitingForRight=null;preview();showHint('Cleared');return;}
    if(key==='back'){if(state.waitingForRight){state.waitingForRight=null;}else state.expr=state.expr.slice(0,-1);preview();return;}
    if(['MC','MR','MS','M+','M-'].includes(key)){let value;try{value=evaluate(closeParen(state.expr));}catch{value=Number(result.textContent)||0;}if(key==='MC')state.memory=0;if(key==='MS')state.memory=value;if(key==='M+')state.memory+=value;if(key==='M-')state.memory-=value;if(key==='MR')setExpr(fmt(state.memory));showHint(key==='MR'?'Memory recalled':`Memory: ${fmt(state.memory)}`);return;}
    if(key==='equals'){try{state.expr=fmt(evaluate(closeParen(state.expr)));state.waitingForRight=null;preview();write(result,state.expr);}catch(err){write(result,err.message);result.classList.add('error');}return;}
    if(key==='logbase'||key==='root'){if(!state.expr)return;const fn=key==='logbase'?'logbase':'root';state.expr=`${fn}(${state.expr},`;state.waitingForRight=fn;write(expression,state.expr);write(result,'');return;}
    if(state.waitingForRight&&/^[0-9.]$/.test(key)){state.expr+=key;expression.textContent=state.expr;return;}
    if(state.waitingForRight&&['+','-','*','/','^'].includes(key)){state.expr=closeParen(state.expr);state.waitingForRight=null;}
    if(key==='exp-marker'){state.expr+='e';}
    else if(key==='pi'||key==='e'){if(/(?:\d|pi|e|\))$/.test(state.expr))state.expr+='*';state.expr+=key==='pi'?'pi':'e';}
    else if(key==='sign'){if(state.expr)state.expr=`-(${closeParen(state.expr)})`;else state.expr='-';}
    else if(key==='sqrt'||key==='cube'||key==='square'||key==='cbrt'||key==='abs'||['sin','cos','tan','asin','acos','atan','sinh','cosh','tanh','asinh','acosh','atanh','ln','log','log2','exp','pow10','inverse'].includes(key)){
      if(!state.expr){setExpr(`${key}(`);return;}const fn=key==='cube'?'pow3':key==='square'?'pow2':key;const wrapped=closeParen(state.expr);state.expr=fn==='pow2'?`(${wrapped})^2`:fn==='pow3'?`(${wrapped})^3`:`${fn}(${wrapped})`;
    }
    else if(key==='factorial'){state.expr=state.expr?`${closeParen(state.expr)}!`:'0!';}
    else if(key==='percent'){state.expr=state.expr?`${closeParen(state.expr)}%`:'0%';}
    else if(key==='mod'){state.expr+=' mod ';}
    else if(key==='('){if(/(?:\d|pi|e|\))$/.test(state.expr))state.expr+='*';state.expr+='(';}
    else if(key===')'){const depth=(state.expr.match(/\(/g)||[]).length-(state.expr.match(/\)/g)||[]).length;if(depth>0)state.expr+=')';}
    else if(/^[0-9.]$/.test(key)){if(state.expr==='0')state.expr=key;else state.expr+=key;}
    else if(['+','-','*','/','^','%'].includes(key)){state.expr+=key;}
    preview();
  }
  document.addEventListener('click',e=>{const btn=e.target.closest('[data-sci]');if(btn&&document.querySelector('.tcs-calc-window'))press(btn.dataset.sci);if(e.target.closest('.tcs-titlebar')&&document.getElementById('appDialog')?.classList.contains('calculator-minimized'))press('restore');});
  document.addEventListener('keydown',e=>{if(!document.querySelector('.gate-calc'))return;if(e.key==='Escape'){if(document.getElementById('appDialog')?.open)document.getElementById('appDialog').close();return;}if(e.key==='Enter'){e.preventDefault();press('equals');}else if(e.key==='Backspace'){e.preventDefault();press('back');}else if(/^[0-9.]$/.test(e.key)||['+','-','*','/','(',')','%','^'].includes(e.key)){e.preventDefault();press(e.key);}});
})();
