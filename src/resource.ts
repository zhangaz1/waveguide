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

import { FunctionN } from "fp-ts/lib/function";
import { Monad3 } from "fp-ts/lib/Monad";
import { Semigroup } from "fp-ts/lib/Semigroup";
import { Monoid } from "fp-ts/lib/Monoid";
import { RIO } from "./io";
import { Fiber } from "./fiber";
import * as io from "./io";

export enum ManagedTag {
    Pure,
    Bracket,
    Suspended,
    Chain
}

/**
 * A Managed<E, A> is a type that encapsulates the safe acquisition and release of a resource.
 *
 * This is a friendly monadic wrapper around bracketExit.
 */
export type Managed<R, E, A> =
  Pure<A> |
  Bracket<R, E, A> |
  Suspended<R, E, A>  |
  Chain<R, E, any, A>; // eslint-disable-line @typescript-eslint/no-explicit-any

/**
 * The short form of rsource
 */
export type Resource<E, A> = Managed<io.DefaultR, E, A>;

export interface Pure<A> {
    readonly _tag: ManagedTag.Pure;
    readonly value: A;
}

/**
 * Lift a pure value into a resource
 * @param value 
 */
export function pure<A>(value: A): Pure<A> {
    return {
        _tag: ManagedTag.Pure,
        value
    };
}

export interface Bracket<R, E, A> {
    readonly _tag: ManagedTag.Bracket;
    readonly acquire: RIO<R, E, A>;
    readonly release: FunctionN<[A], RIO<R, E, unknown>>;
}

/**
 * Create a resource from an acquisition and release function
 * @param acquire 
 * @param release 
 */
export function bracket<R, E, A>(acquire: RIO<R, E, A>, release: FunctionN<[A], RIO<R, E, unknown>>): Bracket<R, E, A> {
    return {
        _tag: ManagedTag.Bracket,
        acquire,
        release
    };
}

export interface Suspended<R, E, A> {
    readonly _tag: ManagedTag.Suspended;
    readonly suspended: RIO<R, E, Managed<R, E, A>>;
}

/**
 * Lift an IO of a Resource into a resource
 * @param suspended 
 */
export function suspend<R, E, A>(suspended: RIO<R, E, Managed<R, E, A>>): Suspended<R, E, A> {
    return {
        _tag: ManagedTag.Suspended,
        suspended
    };
}

export interface Chain<R, E, L, A> {
    readonly _tag: ManagedTag.Chain;
    readonly left: Managed<R, E, L>;
    readonly bind: FunctionN<[L], Managed<R, E, A>>;
}

/**
 * Compose dependent resourcess.
 * 
 * The scope of left will enclose the scope of the resource produced by bind
 * @param left 
 * @param bind 
 */
export function chain<R, E, L, A>(left: Managed<R, E, L>, bind: FunctionN<[L], Managed<R, E, A>>): Chain<R, E, L, A> {
    return {
        _tag: ManagedTag.Chain,
        left,
        bind
    };
}

/**
 * Curried form of chain
 * @param bind 
 */
export function chainWith<R, E, L, A>(bind: FunctionN<[L], Managed<R, E, A>>): FunctionN<[Managed<R, E, L>], Managed<R, E, A>> {
    return (left) => chain(left, bind);
}

/**
 * Map a resource
 * @param res 
 * @param f 
 */
export function map<R, E, L, A>(res: Managed<R, E, L>, f: FunctionN<[L], A>): Managed<R, E, A> {
    return chain(res, (r) => pure(f(r)));
}

/**
 * Curried form of mapWith
 * @param f 
 */
export function mapWith<L, A>(f: FunctionN<[L], A>): <R, E>(res: Managed<R, E, L>) => Managed<R, E, A> {
    return<R, E>(res: Managed<R, E, L>) => map(res, f);
}

/**
 * Zip two resources together with the given function.
 * 
 * The scope of resa will enclose the scope of resb
 * @param resa 
 * @param resb 
 * @param f 
 */
export function zipWith<R, E, A, B, C>(resa: Managed<R, E, A>,
    resb: Managed<R, E, B>,
    f: FunctionN<[A, B], C>): Managed<R, E, C> {
    return chain(resa, (a) => map(resb, (b) => f(a, b)));
}

/**
 * Zip two resources together as a tuple.
 * 
 * The scope of resa will enclose the scope of resb
 * @param resa 
 * @param resb 
 */
export function zip<R, E, A, B>(resa: Managed<R, E, A>, resb: Managed<R, E, B>): Managed<R, E, readonly [A, B]> {
    return zipWith(resa, resb, (a, b) => [a, b] as const);
}

export function ap<R, E, A, B>(resa: Managed<R, E, A>, resfab: Managed<R, E, FunctionN<[A], B>>): Managed<R, E, B> {
    return zipWith(resa, resfab, (a, f) => f(a));
}

export function ap_<R, E, A, B>(resfab: Managed<R, E, FunctionN<[A], B>>, resa: Managed<R, E, A>): Managed<R, E, B> {
    return zipWith(resfab, resa, (f, a) => f(a));
}

/**
 * Curried data last form of use
 * @param f 
 */
export function consume<R, E, A, B>(f: FunctionN<[A], RIO<R, E, B>>): FunctionN<[Managed<R, E, A>], RIO<R, E, B>> {
    // eslint-disable-next-line @typescript-eslint/no-use-before-define
    return (r) => use(r, f);
}

/**
 * Create a Resource from the fiber of an IO.
 * The acquisition of this resource corresponds to forking rio into a fiber.
 * The destruction of the resource is interrupting said fiber.
 * @param rio 
 */
export function fiber<R, E, A>(rio: RIO<R, E, A>): Managed<R, never, Fiber<E, A>> {
    return bracket(io.fork(rio), (fiber) => fiber.interrupt);
}

/**
 * Create a Resource by wrapping an IO producing a value that does not need to be disposed
 * 
 * @param res 
 * @param f 
 */
export function encaseRIO<R, E, A>(rio: RIO<R, E, A>): Managed<R, E, A> {
    return bracket(rio, () => io.unit);
}

/**
 * Use a resource to produce a program that can be run.s
 * @param res 
 * @param f 
 */
export function use<R, E, A, B>(res: Managed<R, E, A>, f: FunctionN<[A], RIO<R, E, B>>): RIO<R, E, B> {
    switch (res._tag) {
        case ManagedTag.Pure:
            return f(res.value);
        case ManagedTag.Bracket:
            return io.bracket(res.acquire, res.release, f);
        case ManagedTag.Suspended:
            return io.chain(res.suspended, consume(f));
        case ManagedTag.Chain:
            return use(res.left, (a) => use(res.bind(a), f));
        default:
            throw new Error(`Die: Unrecognized current type ${res}`);
    }
}

/**
 * Provide a Managed as a resource to a resource
 * @param res 
 * @param rio 
 */
export function provideTo<R, E, A, B>(res: Managed<R, E, A>, rio: RIO<A, E, B>): RIO<io.DefaultR, E, B> {
    return use(res, (r) => io.provideEnv(r, rio));
}

export const URI = "Resource";
export type URI = typeof URI;

declare module "fp-ts/lib/HKT" {
    interface URItoKind3<R, E, A> {
        Resource: Managed<R, E, A>;
    }
}
export const instances: Monad3<URI> = {
    URI,
    of: pure,
    map,
    ap: ap_,
    chain
} as const;

export function getSemigroup<R, E, A>(Semigroup: Semigroup<A>): Semigroup<Managed<R, E, A>> {
    return {
        concat(x: Managed<R, E, A>, y: Managed<R, E, A>): Managed<R, E, A> {
            return zipWith(x, y, Semigroup.concat)
        }
    };
}

export function getMonoid<R, E, A>(Monoid: Monoid<A>): Monoid<Managed<R, E, A>> {
    return {
        ...getSemigroup(Monoid),
        empty: pure(Monoid.empty)
    }
}
