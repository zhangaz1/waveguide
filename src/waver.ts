// Copyright 2019 Ryan Zeigler
// 
// Licensed under the Apache License, Version 2.0 (the "License");
// you may not use this file except in compliance with the License.
// You may obtain a copy of the License at
// 
//     http://www.apache.org/licenses/LICENSE-2.0
// 
// Unless required by applicable law or agreed to in writing, software
// distributed under the License is distributed on an "AS IS" BASIS,
// WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
// See the License for the specific language governing permissions and
// limitations under the License.

import { Wave } from "./wave";
import * as wave from "./wave";
import { constant, FunctionN, flow, Lazy, identity } from "fp-ts/lib/function";
import { Option } from "fp-ts/lib/Option";
import { Exit, Cause } from "./exit";
import * as exit from "./exit";
import { Either } from "fp-ts/lib/Either";
import { Runtime } from "./runtime";
import { tuple2, fst, snd } from "./support/util";
import { Fiber } from "./fiber";
import { MonadThrow3 } from "fp-ts/lib/MonadThrow";
import { Applicative3 } from "fp-ts/lib/Applicative";

export type WaveR<R, E, A> = (r: R) => Wave<E, A>;


export function pure<A>(a: A): WaveR<{}, never, A> {
    return constant(wave.pure(a));
}

export function raised<E>(e: Cause<E>): WaveR<{}, E, never> {
    return constant(wave.raised(e));
}

export function raiseError<E>(e: E): WaveR<{}, E, never> {
    return raised(exit.raise(e))
}

export function raiseAbort(u: unknown): WaveR<{}, never, never> {
    return raised(exit.abort(u));
}

export const raiseInterrupt: WaveR<{}, never, never> = raised(exit.interrupt);

export function completed<E, A>(exit: Exit<E, A>): WaveR<{}, E, A> {
    return constant(wave.completed(exit));
}

export function encaseWave<E, A>(w: Wave<E, A>): WaveR<{}, E, A> {
    return constant(w);
}

export function interruptibleRegion<R, E, A>(inner: WaveR<R, E, A>, flag: boolean): WaveR<R, E, A> {
    return (r: R) =>
        wave.interruptibleRegion(inner(r), flag);
}

export function chain<R, E, A, B>(inner: WaveR<R, E, A>, bind: FunctionN<[A], WaveR<R, E, B>>): WaveR<R, E, B> {
    return (r: R) =>
        wave.chain(inner(r), (a) => bind(a)(r));
}

export const encaseEither: <E, A>(e: Either<E, A>) => WaveR<{}, E, A> =
    flow(wave.encaseEither, encaseWave);

export function encaseOption<E, A>(o: Option<A>, onError: Lazy<E>): WaveR<{}, E, A> {
    return encaseWave(wave.encaseOption(o, onError));
}

export function flatten<R, E, A>(inner: WaveR<R, E, WaveR<R, E, A>>): WaveR<R, E, A> {
    return chain(inner, identity);
}

export function chainWith<R, E, Z, A>(bind: FunctionN<[Z], WaveR<R, E, A>>): FunctionN<[WaveR<R, E, Z>], WaveR<R, E, A>> {
    return (w) => chain(w, bind);
}

export function foldExit<R, E1, E2, A1, A2>(
    inner: WaveR<R, E1, A1>,
    failure: FunctionN<[Cause<E1>], WaveR<R, E2, A2>>,
    success: FunctionN<[A1], WaveR<R, E2, A2>>): WaveR<R, E2, A2> {
    return (r: R) =>
        wave.foldExit(inner(r), (cause) => failure(cause)(r), (a) => success(a)(r));
}

export function foldExitWith<R, E1, E2, A1, A2>(failure: FunctionN<[Cause<E1>], WaveR<R, E2, A2>>,
    success: FunctionN<[A1], WaveR<R, E2, A2>>): FunctionN<[WaveR<R, E1, A1>], WaveR<R, E2, A2>> {
    return (w) => foldExit(w, failure, success);
}

export const accessInterruptible: WaveR<{}, never, boolean> = encaseWave(wave.accessInterruptible);

export const accessRuntime: WaveR<{}, never, Runtime> = encaseWave(wave.accessRuntime);

export function map<R, E, A, B>(base: WaveR<R, E, A>, f: FunctionN<[A], B>): WaveR<R, E, B> {
    return flow(base, wave.mapWith(f));
}

export function as<R, E, A, B>(w: WaveR<R, E, A>, b: B): WaveR<R, E, B> {
    return flow(w, wave.to(b));
}

export function to<B>(b: B): <R, E, A>(w: WaveR<R, E, A>) => WaveR<R, E, B> {
    return (w) => as(w, b);
}

export function chainTap<R, E, A>(base: WaveR<R, E, A>, bind: FunctionN<[A], WaveR<R, E, unknown>>): WaveR<R, E, A> {
    return chain(base, (a) => as(bind(a), a));
}

export function chainTapWith<R, E, A>(bind: FunctionN<[A], WaveR<R, E, unknown>>): (inner: WaveR<R, E, A>) => WaveR<R, E, A> {
    return (w) => chainTap(w, bind);
}

export function asUnit<R, E, A>(w: WaveR<R, E, A>): WaveR<R, E, void> {
    return as(w, undefined);
}

export const unit: WaveR<{}, never, void> = pure(undefined);

export function chainError<R, E1, E2, A>(w: WaveR<R, E1, A>, f: FunctionN<[E1], WaveR<R, E2, A>>): WaveR<R, E2, A> {
    return foldExit(w, (cause) => cause._tag === exit.ExitTag.Raise ? f(cause.error) : completed(cause), (a) => pure(a) as WaveR<R, E2, A>);
}

export function chainErrorWith<R, E1, E2, A>(f: FunctionN<[E1], WaveR<R, E2, A>>): FunctionN<[WaveR<R, E1, A>], WaveR<R, E2, A>> {
    return (io) => chainError(io, f);
}

export function mapError<R, E1, E2, A>(io: WaveR<R, E1, A>, f: FunctionN<[E1], E2>): WaveR<R, E2, A> {
    return chainError<R, E1, E2, A>(io, flow(f, raiseError));
}

export function mapErrorWith<E1, E2>(f: FunctionN<[E1], E2>): <R, A>(w: WaveR<R, E1, A>) => WaveR<R, E2, A> {
    return (w) => mapError(w, f);
}

export function bimap<R, E1, E2, A, B>(io: WaveR<R, E1, A>, leftMap: FunctionN<[E1], E2>, rightMap: FunctionN<[A], B>): WaveR<R, E2, B> {
    return foldExit<R, E1, E2, A, B>(io,
        (cause) => cause._tag === exit.ExitTag.Raise ? raiseError(leftMap(cause.error)) : completed(cause),
        flow(rightMap, pure)
    );
}


export function bimapWith<E1, E2, A, B>(leftMap: FunctionN<[E1], E2>,
    rightMap: FunctionN<[A], B>): <R>(w: WaveR<R, E1, A>) => WaveR<R, E2, B> {
    return (io) => bimap(io, leftMap, rightMap);
}

export function zipWith<R, E, A, B, C>(first: WaveR<R, E, A>, second: WaveR<R, E, B>, f: FunctionN<[A, B], C>): WaveR<R, E, C> {
    return chain(first, (a) => map(second, (b) => f(a, b)));
}

export function zip<R, E, A, B>(first: WaveR<R, E, A>, second: WaveR<R, E, B>): WaveR<R, E, readonly [A, B]> {
    return zipWith(first, second, tuple2);
}

export function applyFirst<R, E, A, B>(first: WaveR<R, E, A>, second: WaveR<R, E, B>): WaveR<R, E, A> {
    return zipWith(first, second, fst);
}

export function applySecond<R, E, A, B>(first: WaveR<R, E, A>, second: WaveR<R, E, B>): WaveR<R, E, B> {
    return zipWith(first, second, snd);
}

/**
 * Evaluate two IOs in sequence and produce the value of the second.
 * This is suitable for cases where second is recursively defined
 * @param first 
 * @param second 
 */
export function applySecondL<R, E, A, B>(first: WaveR<R, E, A>, second: Lazy<WaveR<R, E, B>>): WaveR<R, E, B> {
    return chain(first, () => second());
}

export function ap<R, E, A, B>(wa: WaveR<R, E, A>, wf: WaveR<R, E, FunctionN<[A], B>>): WaveR<R, E, B> {
    return zipWith(wa, wf, (a, f) => f(a));
}

export function ap_<R, E, A, B>( wf: WaveR<R, E, FunctionN<[A], B>>, wa: WaveR<R, E, A>): WaveR<R, E, B> {
    return zipWith(wf, wa, (f, a) => f(a));
}

export function flip<R, E, A>(wa: WaveR<R, E, A>): WaveR<R, A, E> {
    return foldExit<R, E, A, A, E>(
        wa,
        (error) => error._tag === exit.ExitTag.Raise ? pure(error.error) : completed(error),
        raiseError
    );
}

export function forever<R, E, A>(wa: WaveR<R, E, A>): WaveR<R, E, A> {
    return chain(wa, () => forever(wa));
}

export function result<R, E, A>(wa: WaveR<R, E, A>): WaveR<R, never, Exit<E, A>> {
    return foldExit<R, E, never, A, Exit<E, A>>(wa, (c) => pure(c) as WaveR<R, never, Exit<E, A>>, (d) => pure(exit.done(d)));
}

export function interruptible<R, E, A>(wa: WaveR<R, E, A>): WaveR<R, E, A> {
    return interruptibleRegion(wa, true);
}

export function uninterruptible<R, E, A>(wa: WaveR<R, E, A>): WaveR<R, E, A> {
    return interruptibleRegion(wa, false);
}

export function after(ms: number): WaveR<{}, never, void> {
    return encaseWave(wave.after(ms));
}

export type InterruptMaskCutout<R, E, A> = FunctionN<[WaveR<R, E, A>], WaveR<R, E, A>>;


function makeInterruptMaskCutout<R, E, A>(state: boolean): InterruptMaskCutout<R, E, A> {
    return (inner: WaveR<R, E, A>) => interruptibleRegion(inner, state);
}

export function uninterruptibleMask<R, E, A>(f: FunctionN<[InterruptMaskCutout<R, E, A>], WaveR<R, E, A>>): WaveR<R, E, A> {
    return chain(accessInterruptible as WaveR<R, E, boolean>,
        (flag) => uninterruptible(f(makeInterruptMaskCutout(flag))));
}

export function interruptibleMask<R, E, A>(f: FunctionN<[InterruptMaskCutout<R, E, A>], WaveR<R, E, A>>): WaveR<R, E, A> {
    return chain(accessInterruptible as WaveR<R, E, boolean>,
        (flag) => interruptible(f(makeInterruptMaskCutout(flag)))
    );
}

export function bracketExit<R, E, A, B>(acquire: WaveR<R, E, A>, release: FunctionN<[A, Exit<E, B>], WaveR<R, E, unknown>>, use: FunctionN<[A], WaveR<R, E, B>>): WaveR<R, E, B> {
    return (r: R) => wave.bracketExit(
        acquire(r),
        (a, exit) => release(a, exit)(r),
        (a) => use(a)(r)
    )
}

export function bracket<R, E, A, B>(acquire: WaveR<R, E, A>, release: FunctionN<[A], WaveR<R, E, unknown>>, use: FunctionN<[A], WaveR<R, E, B>>): WaveR<R, E, B> {
    return bracketExit(acquire, (e) => release(e), use);
}

export function onComplete<R, E, A>(wa: WaveR<R, E, A>, finalizer: WaveR<R, E, unknown>): WaveR<R, E, A> {
    return (r: R) => wave.onComplete(wa(r), finalizer(r));
}

export function onInterrupted<R, E, A>(wa: WaveR<R, E, A>, finalizer: WaveR<R, E, unknown>): WaveR<R, E, A> {
    return (r: R) => wave.onInterrupted(wa(r), finalizer(r));
}

export const shifted: WaveR<{}, never, void> = encaseWave(wave.shifted);

export function shiftBefore<R, E, A>(wa: WaveR<R, E, A>): WaveR<R, E, A> {
    return applySecond(shifted as WaveR<R, E, void>, wa);
}

export function shiftAfter<R, E, A>(wa: WaveR<R, E, A>): WaveR<R, E, A> {
    return applyFirst(wa, shifted as WaveR<R, E, void>);
}

export const shiftedAsync: WaveR<{}, never, void> = encaseWave(wave.shiftedAsync);

export function shiftAsyncBefore<R, E, A>(io: WaveR<R, E, A>): WaveR<R, E, A> {
    return applySecond(shiftedAsync as WaveR<R, E, void>, io);
}

export function shiftAsyncAfter<R, E, A>(io: WaveR<R, E, A>): WaveR<R, E, A> {
    return applyFirst(io, shiftedAsync as WaveR<R, E, void>);
}

export const never: WaveR<{}, never, never> = encaseWave(wave.never);

export function delay<R, E, A>(inner: WaveR<R, E, A>, ms: number): WaveR<R, E, A> {
    return applySecond(after(ms) as WaveR<R, E, void>, inner);
}

export function fork<R, E, A>(wa: WaveR<R, E, A>, name?: string): WaveR<R, never, Fiber<E, A>> {
    return (r: R) => wave.fork(wa(r), name);
}

export function raceFold<R, E1, E2, A, B, C>(first: WaveR<R, E1, A>, second: WaveR<R, E1, B>,
    onFirstWon: FunctionN<[Exit<E1, A>, Fiber<E1, B>], WaveR<R, E2, C>>,
    onSecondWon: FunctionN<[Exit<E1, B>, Fiber<E1, A>], WaveR<R, E2, C>>): WaveR<R, E2, C> {
    return (r: R) =>
        wave.raceFold(first(r), second(r), (exit, fiber) => onFirstWon(exit, fiber)(r), (exit, fiber) => onSecondWon(exit, fiber)(r));
}

export function timeoutFold<R, E1, E2, A, B>(source: WaveR<R, E1, A>, ms: number, onTimeout: FunctionN<[Fiber<E1, A>], WaveR<R, E2, B>>, onCompleted: FunctionN<[Exit<E1, A>], WaveR<R, E2, B>>): WaveR<R, E2, B> {
    return raceFold<R, E1, E2, A, void, B>(
        source, after(ms), 
        (exit, delayFiber) => applySecond(encaseWave(delayFiber.interrupt) as WaveR<R, never, void>,
        onCompleted(exit)),
        (_, fiber) => onTimeout(fiber))
}

export function raceFirst<R, E, A>(io1: WaveR<R, E, A>, io2: WaveR<R, E, A>): WaveR<R, E, A> {
    return (r: R) => wave.raceFirst(io1(r), io2(r));
}

export function race<R, E, A>(io1: WaveR<R, E, A>, io2: WaveR<R, E, A>): WaveR<R, E, A> {
    return (r: R) => wave.race(io1(r), io2(r));
}

export function parZipWith<R, E, A, B, C>(io1: WaveR<R, E, A>, io2: WaveR<R, E, B>, f: FunctionN<[A, B], C>): WaveR<R, E, C>{
    return (r: R) => wave.parZipWith(io1(r), io2(r), f);
}

export function parZip<R, E, A, B>(ioa: WaveR<R, E, A>, iob: WaveR<R, E, B>): WaveR<R, E, readonly [A, B]> {
    return parZipWith(ioa, iob, tuple2);
}

export function parApplyFirst<R, E, A, B>(ioa: WaveR<R, E, A>, iob: WaveR<R, E, B>): WaveR<R, E, A> {
    return parZipWith(ioa, iob, fst);
}

export function parApplySecond<R, E, A, B>(ioa: WaveR<R, E, A>, iob: WaveR<R, E, B>): WaveR<R, E, B> {
    return parZipWith(ioa, iob, snd);
}

export function parAp<R, E, A, B>(ioa: WaveR<R, E, A>, iof: WaveR<R, E, FunctionN<[A], B>>): WaveR<R, E, B> {
    return parZipWith(ioa, iof, (a, f) => f(a));
}

export function parAp_<R, E, A, B>(iof: WaveR<R, E, FunctionN<[A], B>>, ioa: WaveR<R, E, A>): WaveR<R, E, B> {
    return parZipWith(iof, ioa, (f, a) => f(a));
}

export function orAbort<R, E, A>(ioa: WaveR<R, E, A>): WaveR<R, never, A> {
    return flow(ioa, wave.orAbort);
}

export function timeoutOption<R, E, A>(source: WaveR<R, E, A>, ms: number): WaveR<R, E, Option<A>> {
    return (r: R) => wave.timeoutOption(source(r), ms);
}

export function fromPromise<R, A>(thunk: FunctionN<[R], Promise<A>>): WaveR<R, unknown, A> {
    return (r: R) => wave.fromPromise(() => thunk(r));
}

export const URI = "WaveR";
export type URI = typeof URI;

declare module "fp-ts/lib/HKT" {
    interface URItoKind3<R, E, A> {
        WaveR: WaveR<R, E, A>
    }
}

export const instances: MonadThrow3<URI> = {
    URI,
    map,
    of: <R, E, A>(a: A): WaveR<R, E, A> => pure(a),
    ap: ap_,
    chain,
    throwError: <R, E, A>(e: E): WaveR<R, E, A> => raiseError(e)
};

export const parInstances: Applicative3<URI> = {
    URI,
    map,
    of: <R, E, A>(a: A): WaveR<R, E, A> => pure(a),
    ap: parAp_
}